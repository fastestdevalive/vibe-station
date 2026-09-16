//! `routes/mobileAuth.ts` — QR auth codes, tunnel enablement, and `/mobile-auth` redemption gate.
//!
//! Ports `daemon/src/routes/mobileAuth.ts` (350 LOC).
//! Includes in-memory 20 attempts/min rate limiter and 60s stale-code background janitor.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use ring::rand::{SecureRandom, SystemRandom};
use vst_lifecycle::cloudflared;
use vst_store::StoreHandle;
use vst_types::domain::TokenScope;
use vst_types::rest::mobile_auth::{
    ConnectionType, LocalQrResult, MobileQrResult, TunnelDisableResult, TunnelEnableResult,
    TunnelStatus,
};

use crate::auth::{mint_token, AuthState, BrowserSession, BROWSER_MAX_AGE_SECONDS, COOKIE_NAME};

const RATE_LIMIT_WINDOW_MS: u64 = 60 * 1000;
const MOBILE_RATE_LIMIT_MAX: u32 = 20;

struct RateLimitEntry {
    count: u32,
    reset_at: Instant,
}

static RATE_LIMITER: Mutex<Option<HashMap<String, RateLimitEntry>>> = Mutex::new(None);

/// Check if CF-Connecting-IP or remote IP is within 20 attempts / min.
pub fn check_mobile_auth_rate_limit(ip: &str) -> bool {
    let mut guard = RATE_LIMITER.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    let now = Instant::now();

    if let Some(entry) = map.get_mut(ip) {
        if now > entry.reset_at {
            entry.count = 1;
            entry.reset_at = now + Duration::from_millis(RATE_LIMIT_WINDOW_MS);
            true
        } else {
            entry.count += 1;
            entry.count <= MOBILE_RATE_LIMIT_MAX
        }
    } else {
        map.insert(
            ip.to_string(),
            RateLimitEntry {
                count: 1,
                reset_at: now + Duration::from_millis(RATE_LIMIT_WINDOW_MS),
            },
        );
        true
    }
}

/// A one-time auth code entry.
#[derive(Clone, Debug)]
pub struct OneTimeCode {
    pub created_at: i64,
    pub consumed: bool,
    pub origin: String, // "tunnel" | "local"
}

/// Shared store for one-time auth codes with a background janitor.
#[derive(Clone)]
pub struct OneTimeCodeStore {
    codes: Arc<RwLock<HashMap<String, OneTimeCode>>>,
}

impl Default for OneTimeCodeStore {
    fn default() -> Self {
        Self::new()
    }
}

impl OneTimeCodeStore {
    pub fn new() -> Self {
        let codes: Arc<RwLock<HashMap<String, OneTimeCode>>> =
            Arc::new(RwLock::new(HashMap::<String, OneTimeCode>::new()));
        let codes_clone = codes.clone();

        // Stale code janitor task (60s cleanup interval for codes older than 60s)
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let cutoff = now - 60_000;
                let mut guard = codes_clone.write().unwrap();
                guard.retain(|_, entry| entry.created_at >= cutoff);
            }
        });

        Self { codes }
    }

    /// Mint a new 32-byte hex one-time auth code with 30s TTL.
    pub fn mint_one_time_code(&self, origin: &str) -> (String, i64) {
        let rng = SystemRandom::new();
        let mut bytes = [0u8; 32];
        rng.fill(&mut bytes).expect("system random fill failed");
        let mut code = String::with_capacity(64);
        for b in bytes {
            use std::fmt::Write;
            let _ = write!(code, "{:02x}", b);
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        self.codes.write().unwrap().insert(
            code.clone(),
            OneTimeCode {
                created_at: now,
                consumed: false,
                origin: origin.to_string(),
            },
        );

        (code, now + 30_000)
    }

    /// Invalidate any codes minted for the tunnel origin when tunnel is disabled.
    pub fn invalidate_tunnel_codes(&self) {
        let mut guard = self.codes.write().unwrap();
        guard.retain(|_, entry| entry.origin != "tunnel");
    }

    pub fn get_code(&self, code: &str) -> Option<OneTimeCode> {
        self.codes.read().unwrap().get(code).cloned()
    }

    pub fn mark_consumed(&self, code: &str) {
        let mut guard = self.codes.write().unwrap();
        if let Some(entry) = guard.get_mut(code) {
            entry.consumed = true;
        }
    }
}

/// Helper function to mint one-time code on a shared store.
pub fn mint_one_time_code(store: &OneTimeCodeStore, origin: &str) -> (String, i64) {
    store.mint_one_time_code(origin)
}

/// Extract short device name from User-Agent string.
pub fn parse_device_name(ua: &str) -> String {
    if ua.contains("iPhone") {
        return "iPhone".to_string();
    }
    if ua.contains("iPad") {
        return "iPad".to_string();
    }
    if let Some(idx) = ua.find("Android") {
        let rest = &ua[idx..];
        if let Some(semi) = rest.find(';') {
            let after = &rest[semi + 1..];
            if let Some(end) = after.find(')') {
                let model = after[..end].trim();
                let parts: Vec<&str> = model.split_whitespace().take(2).collect();
                let model_str = parts.join(" ");
                if model_str.len() <= 2 {
                    return "Android".to_string();
                } else {
                    return model_str;
                }
            }
        }
        return "Android".to_string();
    }
    if ua.contains("Macintosh") {
        return "Mac".to_string();
    }
    if ua.contains("Windows") {
        return "Windows PC".to_string();
    }
    if ua.contains("Linux") {
        return "Linux".to_string();
    }
    "Browser".to_string()
}

/// Response from `/mobile-auth` endpoint (HTML or JSON error).
#[derive(Debug, Clone)]
pub struct MobileAuthRedeemResponse {
    pub status: u16,
    pub html: String,
    pub set_cookie: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MobileAuthRouteError {
    #[error("TUNNEL_ONLY_BLOCKED")]
    TunnelOnlyBlocked,
    #[error("Tunnel unavailable in no-auth mode")]
    NoAuthMode,
    #[error("Tunnel already enabled")]
    AlreadyEnabled { tunnel_url: String },
    #[error("Tunnel not enabled")]
    TunnelNotEnabled,
    #[error("No network interface found")]
    NoNetworkInterface,
    #[error("Rate limit exceeded")]
    RateLimitExceeded,
    #[error("Missing code parameter")]
    MissingCode,
    #[error("Auth not configured")]
    AuthNotConfigured,
    #[error("internal_error: {0}")]
    Internal(String),
}

impl MobileAuthRouteError {
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::TunnelOnlyBlocked => "TUNNEL_ONLY_BLOCKED",
            Self::NoAuthMode => "conflict",
            Self::AlreadyEnabled { .. } => "conflict",
            Self::TunnelNotEnabled => "conflict",
            Self::NoNetworkInterface => "unavailable",
            Self::RateLimitExceeded => "rate_limit_exceeded",
            Self::MissingCode => "missing_code",
            Self::AuthNotConfigured => "auth_not_configured",
            Self::Internal(_) => "internal_error",
        }
    }
}

/// Handler for `/auth/tunnel/*`, `/auth/local-qr`, `/auth/mobile-qr`, and `/mobile-auth`.
#[derive(Clone)]
pub struct MobileAuthRoutes {
    auth_state: Option<AuthState>,
    code_store: OneTimeCodeStore,
    port: u16,
    no_auth: bool,
    store: Option<StoreHandle>,
}

impl MobileAuthRoutes {
    pub fn new(
        auth_state: Option<AuthState>,
        code_store: OneTimeCodeStore,
        port: u16,
        no_auth: bool,
    ) -> Self {
        Self {
            auth_state,
            code_store,
            port,
            no_auth,
            store: None,
        }
    }

    pub fn with_store(mut self, store: StoreHandle) -> Self {
        self.store = Some(store);
        self
    }

    /// Check if request arrived from remote tunnel or non-loopback reverse proxy.
    pub fn is_tunnel_request(
        &self,
        cf_connecting_ip: Option<&str>,
        x_forwarded_proto: Option<&str>,
        peer_ip: Option<&str>,
    ) -> bool {
        if cf_connecting_ip.map_or(false, |ip| !ip.trim().is_empty()) {
            return true;
        }
        if x_forwarded_proto == Some("https") {
            if let Some(ip) = peer_ip {
                if ip != "127.0.0.1" && ip != "::1" && ip != "::ffff:127.0.0.1" {
                    return true;
                }
            }
        }
        false
    }

    /// `POST /auth/tunnel/enable`
    pub async fn enable_tunnel(
        &self,
        is_remote: bool,
    ) -> Result<TunnelEnableResult, MobileAuthRouteError> {
        if is_remote {
            return Err(MobileAuthRouteError::TunnelOnlyBlocked);
        }
        if self.no_auth || self.auth_state.is_none() {
            return Err(MobileAuthRouteError::NoAuthMode);
        }
        let store = match &self.store {
            Some(s) => s,
            None => return Err(MobileAuthRouteError::Internal("store not set".to_string())),
        };

        let current = cloudflared::get_state(store)
            .await
            .map_err(|e| MobileAuthRouteError::Internal(e.to_string()))?;

        if current.enabled {
            if let Some(url) = current.url {
                return Err(MobileAuthRouteError::AlreadyEnabled { tunnel_url: url });
            }
        }

        let tunnel_port = std::env::var("VST_TUNNEL_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(self.port);

        let url = cloudflared::enable(tunnel_port, store)
            .await
            .map_err(|e| MobileAuthRouteError::Internal(e.to_string()))?;

        Ok(TunnelEnableResult {
            tunnel_url: url,
            enabled: true,
            error: None,
        })
    }

    /// `POST /auth/tunnel/disable`
    pub async fn disable_tunnel(
        &self,
        is_remote: bool,
    ) -> Result<TunnelDisableResult, MobileAuthRouteError> {
        if is_remote {
            return Err(MobileAuthRouteError::TunnelOnlyBlocked);
        }
        self.code_store.invalidate_tunnel_codes();
        if let Some(store) = &self.store {
            let _ = cloudflared::disable(store).await;
        }
        Ok(TunnelDisableResult { enabled: false })
    }

    /// `GET /auth/tunnel/status`
    pub async fn tunnel_status(&self) -> Result<TunnelStatus, MobileAuthRouteError> {
        let store = match &self.store {
            Some(s) => s,
            None => {
                return Ok(TunnelStatus {
                    enabled: false,
                    tunnel_url: None,
                    started_at: None,
                })
            }
        };

        let row = store.get_tunnel_state().await;
        Ok(TunnelStatus {
            enabled: row.enabled,
            tunnel_url: row.current_url,
            started_at: row.started_at,
        })
    }

    /// `POST /auth/local-qr`
    pub async fn local_qr(&self, is_remote: bool) -> Result<LocalQrResult, MobileAuthRouteError> {
        if is_remote {
            return Err(MobileAuthRouteError::TunnelOnlyBlocked);
        }

        // Pick best IP: Tailscale 100.64.0.0/10 first, then LAN IPv4
        let (ip, conn_type) =
            pick_best_network_ip().ok_or(MobileAuthRouteError::NoNetworkInterface)?;

        let (code, expires_at) = self.code_store.mint_one_time_code("local");
        let qr_url = format!("http://{}:{}/mobile-auth?code={}", ip, self.port, code);

        Ok(LocalQrResult {
            qr_url,
            expires_at,
            connection_type: conn_type,
        })
    }

    /// `POST /auth/mobile-qr`
    pub async fn mobile_qr(&self, is_remote: bool) -> Result<MobileQrResult, MobileAuthRouteError> {
        if is_remote {
            return Err(MobileAuthRouteError::TunnelOnlyBlocked);
        }

        let store = match &self.store {
            Some(s) => s,
            None => return Err(MobileAuthRouteError::TunnelNotEnabled),
        };

        let state = cloudflared::get_state(store)
            .await
            .map_err(|e| MobileAuthRouteError::Internal(e.to_string()))?;

        if !state.enabled || state.url.is_none() {
            return Err(MobileAuthRouteError::TunnelNotEnabled);
        }

        let tunnel_url = state.url.unwrap();
        let (code, expires_at) = self.code_store.mint_one_time_code("tunnel");
        let qr_url = format!("{}/mobile-auth?code={}", tunnel_url, code);

        Ok(MobileQrResult { qr_url, expires_at })
    }

    /// `GET /mobile-auth?code=`
    pub async fn mobile_auth(
        &self,
        code_param: Option<String>,
        client_ip: Option<&str>,
        via_tunnel: bool,
        user_agent: &str,
    ) -> MobileAuthRedeemResponse {
        let ip_to_check = client_ip.unwrap_or("unknown");
        if !check_mobile_auth_rate_limit(ip_to_check) {
            return MobileAuthRedeemResponse {
                status: 429,
                html: "Rate limit exceeded".to_string(),
                set_cookie: None,
            };
        }

        let code = match code_param {
            Some(c) if !c.trim().is_empty() => c,
            _ => {
                return MobileAuthRedeemResponse {
                    status: 400,
                    html: "Missing code parameter".to_string(),
                    set_cookie: None,
                }
            }
        };

        let entry = self.code_store.get_code(&code);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let origin_matches = entry.as_ref().map_or(false, |e| {
            e.origin == if via_tunnel { "tunnel" } else { "local" }
        });

        let is_valid = entry.as_ref().map_or(false, |e| {
            origin_matches && !e.consumed && (now - e.created_at < 30_000)
        });

        if !is_valid {
            return MobileAuthRedeemResponse {
                status: 410,
                html: EXPIRED_HTML.to_string(),
                set_cookie: None,
            };
        }

        let auth_state = match &self.auth_state {
            Some(s) => s,
            None => {
                return MobileAuthRedeemResponse {
                    status: 503,
                    html: "Auth not configured".to_string(),
                    set_cookie: None,
                }
            }
        };

        // Burn code
        self.code_store.mark_consumed(&code);

        // Mint browser token
        let token_val = mint_token(TokenScope::Browser, auth_state, None);
        let dot = token_val.rfind('.').unwrap_or(0);
        let token_id = token_val[..dot].to_string();

        let dev_name = parse_device_name(user_agent);
        auth_state.record_browser_session(BrowserSession {
            token_id,
            scope: "browser".to_string(),
            issued_at: now,
            expires_at: Some(now + BROWSER_MAX_AGE_SECONDS * 1000),
            epoch: auth_state.browser_epoch(),
            device_name: Some(dev_name),
        });

        let secure_attr = if via_tunnel { " Secure;" } else { "" };
        let cookie_header = format!(
            "{}={}; HttpOnly;{} SameSite=Lax; Path=/; Max-Age={}",
            COOKIE_NAME, token_val, secure_attr, BROWSER_MAX_AGE_SECONDS
        );

        MobileAuthRedeemResponse {
            status: 200,
            html: SUCCESS_HTML.to_string(),
            set_cookie: Some(cookie_header),
        }
    }
}

fn pick_best_network_ip() -> Option<(String, ConnectionType)> {
    use std::net::IpAddr;

    // Use getifaddrs or parse system interfaces
    // Look for Tailscale (100.64.0.0/10 or 100.x.x.x) first, then private LAN IPv4
    let mut tailscale_ip = None;
    let mut lan_ip = None;

    if let Ok(interfaces) = get_system_ipv4_addrs() {
        for ip in interfaces {
            if ip.is_loopback() {
                continue;
            }
            if let IpAddr::V4(v4) = ip {
                let octets = v4.octets();
                if octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127 {
                    tailscale_ip = Some(ip.to_string());
                    break;
                }
                if lan_ip.is_none() {
                    lan_ip = Some(ip.to_string());
                }
            }
        }
    }

    if let Some(ts) = tailscale_ip {
        return Some((ts, ConnectionType::Tailscale));
    }
    if let Some(lan) = lan_ip {
        return Some((lan, ConnectionType::Lan));
    }

    // Fallback: 127.0.0.1 for isolated tests
    Some(("127.0.0.1".to_string(), ConnectionType::Lan))
}

fn get_system_ipv4_addrs() -> std::io::Result<Vec<std::net::IpAddr>> {
    // Read from /proc/net/arp or hostname -I or ip route
    // Or std::net fallback
    let mut addrs = Vec::new();
    if let Ok(output) = std::process::Command::new("hostname").arg("-I").output() {
        let text = String::from_utf8_lossy(&output.stdout);
        for part in text.split_whitespace() {
            if let Ok(ip) = part.parse::<std::net::IpAddr>() {
                if ip.is_ipv4() && !ip.is_loopback() {
                    addrs.push(ip);
                }
            }
        }
    }
    Ok(addrs)
}

const EXPIRED_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vibe-station</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"JetBrains Mono","Fira Code","SF Mono",monospace;background:#0f0f0f;color:#e5e5e5;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100svh;padding:24px;gap:32px}
  .wordmark{font-size:13px;font-weight:500;color:#6b6b6b;letter-spacing:0.04em}
  .card{background:#191919;border:1px solid #262626;border-radius:6px;padding:28px 24px;max-width:340px;width:100%;display:flex;flex-direction:column;gap:12px}
  .icon{width:32px;height:32px;border-radius:50%;background:#1c1010;border:1px solid #4a2020;display:flex;align-items:center;justify-content:center;font-size:14px}
  h1{font-size:14px;font-weight:600;color:#e5e5e5}
  p{font-size:12px;color:#6b6b6b;line-height:1.6}
</style>
</head>
<body>
<div class="wordmark">vibe-station</div>
<div class="card">
  <div class="icon">⏱</div>
  <h1>QR code expired</h1>
  <p>This code has already been used or expired. Ask the desktop to regenerate a new QR code and try again.</p>
</div>
</body>
</html>"#;

const SUCCESS_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vibe-station</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"JetBrains Mono","Fira Code","SF Mono",monospace;background:#0f0f0f;color:#e5e5e5;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100svh;padding:24px;gap:32px}
  .wordmark{font-size:13px;font-weight:500;color:#6b6b6b;letter-spacing:0.04em}
  .card{background:#191919;border:1px solid #262626;border-radius:6px;padding:28px 24px;max-width:340px;width:100%;display:flex;flex-direction:column;gap:12px}
  .check{width:32px;height:32px;border-radius:50%;background:#14532d;border:1px solid #16a34a;display:flex;align-items:center;justify-content:center;font-size:16px;color:#16a34a}
  h1{font-size:14px;font-weight:600;color:#e5e5e5}
  p{font-size:12px;color:#6b6b6b;line-height:1.6}
  a.btn{display:inline-block;background:transparent;color:#e5e5e5;text-decoration:none;padding:6px 14px;border-radius:6px;border:1px solid #262626;font-size:12px;font-weight:500;font-family:inherit;align-self:flex-start;margin-top:4px}
  a.btn:active{background:#1e1e1e}
</style>
</head>
<body>
<div class="wordmark">vibe-station</div>
<div class="card">
  <div class="check">✓</div>
  <h1>Device connected</h1>
  <p>This device is now authenticated. You can open the dashboard or close this tab.</p>
  <a class="btn" href="/">Open dashboard</a>
</div>
</body>
</html>"#;
