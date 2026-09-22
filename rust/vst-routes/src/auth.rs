//! `auth.ts` and `state/auth-state.ts` — HMAC-SHA256 token mint/verify and auth state singleton.
//!
//! Ports `daemon/src/auth.ts` (157 LOC), `daemon/src/state/auth-state.ts` (103 LOC), and `daemon/src/routes/auth.ts` (104 LOC).
//!
//! Preserves token wire format: `<base64url(JSON(payload))>.<HMAC-SHA256-hex>`.
//! Uses constant-time comparison (`subtle::ConstantTimeEq`) for HMAC signature verification.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, RwLock};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::hmac;
use subtle::ConstantTimeEq;
use vst_types::domain::{TokenPayload, TokenScope, VerifyErrorReason, VerifyResult};
use vst_types::rest::auth::{AuthSessionsResult, OkResult, RevokeBrowserResult};
use vst_types::rest::shared::TokenSession;
use vst_ws::broadcaster::{close_auth_expired, WsHub};

pub const COOKIE_NAME: &str = "vst-session";
pub const BROWSER_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const BROWSER_MAX_AGE_SECONDS: i64 = 7 * 24 * 60 * 60;

/// A browser session tracked in auth state before/while it has WS connections.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserSession {
    pub token_id: String,
    pub scope: String,
    pub issued_at: i64,
    pub expires_at: Option<i64>,
    pub epoch: i64,
    pub device_name: Option<String>,
}

/// In-memory mutable auth state.
pub struct AuthStateInner {
    daemon_token: String,
    browser_epoch: i64,
    revoked_token_ids: HashSet<String>,
    minted_browser_sessions: HashMap<String, BrowserSession>,
}

#[derive(Clone)]
pub struct AuthState {
    inner: Arc<RwLock<AuthStateInner>>,
}

impl AuthState {
    pub fn new(daemon_token: impl Into<String>, browser_epoch: i64) -> Self {
        Self {
            inner: Arc::new(RwLock::new(AuthStateInner {
                daemon_token: daemon_token.into(),
                browser_epoch,
                revoked_token_ids: HashSet::new(),
                minted_browser_sessions: HashMap::new(),
            })),
        }
    }

    pub fn daemon_token(&self) -> String {
        self.inner.read().unwrap().daemon_token.clone()
    }

    pub fn browser_epoch(&self) -> i64 {
        self.inner.read().unwrap().browser_epoch
    }

    pub fn set_browser_epoch(&self, epoch: i64) {
        self.inner.write().unwrap().browser_epoch = epoch;
    }

    pub fn record_browser_session(&self, session: BrowserSession) {
        let mut guard = self.inner.write().unwrap();
        guard
            .minted_browser_sessions
            .insert(session.token_id.clone(), session);
    }

    pub fn get_active_browser_sessions(&self) -> Vec<BrowserSession> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let mut guard = self.inner.write().unwrap();
        let current_epoch = guard.browser_epoch;
        let mut valid = Vec::new();
        let mut to_drop = Vec::new();

        for (token_id, s) in guard.minted_browser_sessions.iter() {
            let stale = guard.revoked_token_ids.contains(token_id)
                || s.epoch != current_epoch
                || s.expires_at.map_or(false, |exp| exp <= now);
            if stale {
                to_drop.push(token_id.clone());
            } else {
                valid.push(s.clone());
            }
        }
        for drop_id in to_drop {
            guard.minted_browser_sessions.remove(&drop_id);
        }
        valid
    }

    pub fn get_device_name_for_token(&self, token_id: &str) -> Option<String> {
        self.inner
            .read()
            .unwrap()
            .minted_browser_sessions
            .get(token_id)
            .and_then(|s| s.device_name.clone())
    }

    pub fn revoke_token_id(&self, token_id: &str) {
        self.inner
            .write()
            .unwrap()
            .revoked_token_ids
            .insert(token_id.to_string());
    }

    pub fn is_revoked(&self, token_id: &str) -> bool {
        self.inner
            .read()
            .unwrap()
            .revoked_token_ids
            .contains(token_id)
    }
}

/// Compute HMAC-SHA256 signature for payload bytes with key, formatted as 64 lowercase hex characters.
pub fn hmac_payload(payload_b64: &str, key: &str) -> String {
    let s_key = hmac::Key::new(hmac::HMAC_SHA256, key.as_bytes());
    let tag = hmac::sign(&s_key, payload_b64.as_bytes());
    hex_encode(tag.as_ref())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    for chunk in s.as_bytes().chunks_exact(2) {
        let hi = (chunk[0] as char).to_digit(16)?;
        let lo = (chunk[1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

/// Mint a new signed token for the given scope.
pub fn mint_token(scope: TokenScope, auth_state: &AuthState, custom_exp: Option<i64>) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let (exp, epoch) = if scope == TokenScope::Browser {
        let exp = match custom_exp {
            Some(e) => std::cmp::min(e, now + BROWSER_TTL_MS),
            None => now + BROWSER_TTL_MS,
        };
        (Some(exp), Some(auth_state.browser_epoch()))
    } else {
        (None, None)
    };

    let payload = TokenPayload {
        iat: now,
        scope,
        exp,
        epoch,
    };

    let payload_json = serde_json::to_string(&payload).unwrap_or_default();
    let payload_b64 = URL_SAFE_NO_PAD.encode(payload_json.as_bytes());
    let sig = hmac_payload(&payload_b64, &auth_state.daemon_token());

    format!("{payload_b64}.{sig}")
}

/// Verify a token minted by `mint_token`.
///
/// Uses `subtle::ConstantTimeEq` to prevent timing side channels on HMAC verification.
pub fn verify_token(token: &str, auth_state: &AuthState) -> VerifyResult {
    let dot = match token.rfind('.') {
        Some(idx) => idx,
        None => {
            return VerifyResult::Err {
                reason: VerifyErrorReason::Malformed,
            }
        }
    };

    let payload_b64 = &token[..dot];
    let sig = &token[dot + 1..];

    // Constant-time HMAC compare using subtle::ConstantTimeEq
    let expected_sig = hmac_payload(payload_b64, &auth_state.daemon_token());
    let recv_buf = match hex_decode(sig) {
        Some(b) => b,
        None => {
            return VerifyResult::Err {
                reason: VerifyErrorReason::InvalidSignature,
            }
        }
    };
    let exp_buf = match hex_decode(&expected_sig) {
        Some(b) => b,
        None => {
            return VerifyResult::Err {
                reason: VerifyErrorReason::InvalidSignature,
            }
        }
    };

    if recv_buf.len() != exp_buf.len() || bool::from(!recv_buf.ct_eq(&exp_buf)) {
        return VerifyResult::Err {
            reason: VerifyErrorReason::InvalidSignature,
        };
    }

    let payload_bytes = match URL_SAFE_NO_PAD.decode(payload_b64) {
        Ok(b) => b,
        Err(_) => {
            return VerifyResult::Err {
                reason: VerifyErrorReason::Malformed,
            }
        }
    };

    let payload: TokenPayload = match serde_json::from_slice(&payload_bytes) {
        Ok(p) => p,
        Err(_) => {
            return VerifyResult::Err {
                reason: VerifyErrorReason::Malformed,
            }
        }
    };

    // Scope-shape validation
    if payload.scope == TokenScope::Browser {
        if payload.epoch.is_none() || payload.exp.is_none() {
            return VerifyResult::Err {
                reason: VerifyErrorReason::Malformed,
            };
        }
    } else {
        // cli / tauri must not carry exp
        if payload.exp.is_some() {
            return VerifyResult::Err {
                reason: VerifyErrorReason::Malformed,
            };
        }
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    // Expiry check (browser only)
    if payload.scope == TokenScope::Browser {
        if let Some(exp) = payload.exp {
            if now > exp {
                return VerifyResult::Err {
                    reason: VerifyErrorReason::Expired,
                };
            }
        }
    }

    // Epoch check (browser only)
    if payload.scope == TokenScope::Browser {
        if let Some(ep) = payload.epoch {
            if ep != auth_state.browser_epoch() {
                return VerifyResult::Err {
                    reason: VerifyErrorReason::EpochMismatch,
                };
            }
        }
    }

    // Revocation check
    if auth_state.is_revoked(payload_b64) {
        return VerifyResult::Err {
            reason: VerifyErrorReason::Revoked,
        };
    }

    VerifyResult::Ok { payload }
}

/// Derive token_id (the base64url payload portion) from an Authorization header or cookie.
pub fn extract_token_id_from_auth(
    auth_header: Option<&str>,
    cookie_header: Option<&str>,
) -> Option<String> {
    let token = if let Some(auth) = auth_header {
        if let Some(bearer) = auth.strip_prefix("Bearer ") {
            bearer.trim()
        } else {
            ""
        }
    } else {
        ""
    };

    let token = if token.is_empty() {
        if let Some(cookie) = cookie_header {
            parse_cookie_value(cookie, COOKIE_NAME).unwrap_or_default()
        } else {
            String::new()
        }
    } else {
        token.to_string()
    };

    if token.is_empty() {
        return None;
    }

    let dot = token.rfind('.')?;
    if dot == 0 {
        return None;
    }
    Some(token[..dot].to_string())
}

/// Parse cookie value by name from cookie header.
pub fn parse_cookie_value(cookie_header: &str, name: &str) -> Option<String> {
    for part in cookie_header.split(';') {
        let mut split = part.splitn(2, '=');
        let k = split.next()?.trim();
        let v = split.next()?.trim();
        if k == name {
            return Some(v.to_string());
        }
    }
    None
}

pub type PersistEpochFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type PersistEpochFn = Arc<dyn Fn(i64) -> PersistEpochFuture + Send + Sync>;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthRouteError {
    #[error("DESKTOP_ONLY")]
    DesktopOnly,
    #[error("Session not found.")]
    NotFound,
    #[error("internal_error: {0}")]
    Internal(String),
}

impl AuthRouteError {
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::DesktopOnly => "DESKTOP_ONLY",
            Self::NotFound => "not_found",
            Self::Internal(_) => "internal_error",
        }
    }
}

/// Handler for `/auth/*` routes.
#[derive(Clone)]
pub struct AuthRoutes {
    auth_state: AuthState,
    persist_epoch: Option<PersistEpochFn>,
    ws_hub: Option<Arc<WsHub>>,
}

impl AuthRoutes {
    pub fn new(auth_state: AuthState, persist_epoch: PersistEpochFn) -> Self {
        Self {
            auth_state,
            persist_epoch: Some(persist_epoch),
            ws_hub: None,
        }
    }

    pub fn with_ws_hub(mut self, hub: Arc<WsHub>) -> Self {
        self.ws_hub = Some(hub);
        self
    }

    /// `POST /auth/logout` -> clear session cookie (200).
    pub async fn logout(&self) -> (u16, String, OkResult) {
        let cookie_header = format!(
            "{}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
            COOKIE_NAME
        );
        (200, cookie_header, OkResult { ok: true })
    }

    /// `GET /auth/check` -> 200 ok
    pub async fn check(&self, _auth_payload: Option<&TokenPayload>) -> OkResult {
        OkResult { ok: true }
    }

    /// `GET /auth/sessions` -> list remote sessions
    pub async fn sessions(
        &self,
        auth_payload: Option<&TokenPayload>,
        current_token_id: Option<String>,
    ) -> AuthSessionsResult {
        let is_desktop = match auth_payload {
            None => true,
            Some(p) => p.scope == TokenScope::Tauri,
        };

        let current_scope = match auth_payload {
            Some(p) => match p.scope {
                TokenScope::Cli => "cli",
                TokenScope::Tauri => "tauri",
                TokenScope::Browser => "browser",
                TokenScope::Mobile => "mobile",
            }
            .to_string(),
            None => "tauri".to_string(),
        };

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let active_minted = self.auth_state.get_active_browser_sessions();
        let mut session_map: HashMap<String, TokenSession> = HashMap::new();

        for s in active_minted {
            session_map.insert(
                s.token_id.clone(),
                TokenSession {
                    token_id: s.token_id,
                    scope: s.scope,
                    issued_at: s.issued_at,
                    expires_at: s.expires_at,
                    last_seen_at: s.issued_at,
                    connections: 0,
                    device_name: s.device_name,
                },
            );
        }

        let session_map = RefCell::new(session_map);

        // Merge live WS connections if hub is available
        if let Some(hub) = &self.ws_hub {
            hub.for_each_connection(|conn| {
                // Only remote scopes (browser / mobile) are tracked in the remote sessions list.
                // Desktop (Tauri) and CLI callers are local and represented separately.
                if !matches!(
                    conn.scope(),
                    Some(TokenScope::Browser) | Some(TokenScope::Mobile)
                ) {
                    return;
                }
                if let Some(tid) = conn.token_id() {
                    let exp = conn.token_expires_at();
                    if exp.map_or(false, |e| e <= now) {
                        return;
                    }
                    let mut map = session_map.borrow_mut();
                    if let Some(existing) = map.get_mut(&tid) {
                        existing.connections += 1;
                        existing.last_seen_at = conn.last_seen_at() as i64;
                    } else {
                        let scope_str = match conn.scope() {
                            Some(TokenScope::Mobile) => "mobile",
                            _ => "browser",
                        }
                        .to_string();
                        map.insert(
                            tid.clone(),
                            TokenSession {
                                token_id: tid.clone(),
                                scope: scope_str,
                                issued_at: conn.token_issued_at().unwrap_or(now),
                                expires_at: conn.token_expires_at(),
                                last_seen_at: conn.last_seen_at() as i64,
                                connections: 1,
                                device_name: self.auth_state.get_device_name_for_token(&tid),
                            },
                        );
                    }
                }
            });
        }

        let mut sessions: Vec<TokenSession> = session_map.into_inner().into_values().collect();
        sessions.sort_by_key(|s| std::cmp::Reverse(s.issued_at));

        let current_token_id = if is_desktop { None } else { current_token_id };

        AuthSessionsResult {
            sessions,
            is_desktop,
            current_scope,
            current_token_id,
        }
    }

    /// `POST /auth/sessions/:id/revoke` -> revoke remote session
    pub async fn revoke_session(
        &self,
        target_token_id: &str,
        auth_payload: Option<&TokenPayload>,
    ) -> Result<OkResult, AuthRouteError> {
        if let Some(payload) = auth_payload {
            if payload.scope != TokenScope::Tauri {
                return Err(AuthRouteError::DesktopOnly);
            }
        }

        // Revoke token id in auth state
        self.auth_state.revoke_token_id(target_token_id);

        let found = RefCell::new(false);
        if let Some(hub) = &self.ws_hub {
            hub.for_each_connection(|conn| {
                if conn.token_id().as_deref() == Some(target_token_id) {
                    // This is an auth-caused close: emit 4401 so the client
                    // shows the login screen instead of reconnecting in a loop.
                    close_auth_expired(conn);
                    *found.borrow_mut() = true;
                }
            });
        }

        let mut found = found.into_inner();

        // If not found in live WS, check if it was in active browser sessions
        if !found {
            // Also check minted sessions
            let minted = self.auth_state.get_active_browser_sessions();
            if minted.iter().any(|s| s.token_id == target_token_id) {
                found = true;
            }
        }

        if !found {
            return Err(AuthRouteError::NotFound);
        }

        Ok(OkResult { ok: true })
    }

    /// `POST /auth/revoke-browser` -> bump epoch, revoke all browser sessions
    pub async fn revoke_browser(
        &self,
        auth_payload: Option<&TokenPayload>,
    ) -> Result<RevokeBrowserResult, AuthRouteError> {
        if let Some(payload) = auth_payload {
            if payload.scope != TokenScope::Tauri {
                return Err(AuthRouteError::DesktopOnly);
            }
        }

        let new_epoch = self.auth_state.browser_epoch() + 1;
        self.auth_state.set_browser_epoch(new_epoch);

        if let Some(persist) = &self.persist_epoch {
            persist(new_epoch)
                .await
                .map_err(|e| AuthRouteError::Internal(e))?;
        }

        if let Some(hub) = &self.ws_hub {
            // Bumping the browser epoch invalidates Browser-scope tokens, which
            // is what the remote-session/QR path mints (mobile_auth.rs). Only
            // Browser-scope sockets are closed here — Mobile tokens carry no
            // epoch and aren't invalidated by this bump, so closing a Mobile
            // socket would wrongly send its client to login while the token is
            // still valid. This is an auth-caused close: use 4401 so the client
            // shows the login screen.
            hub.for_each_connection(|conn| {
                if conn.scope() == Some(TokenScope::Browser) {
                    close_auth_expired(conn);
                }
            });
        }

        Ok(RevokeBrowserResult {
            ok: true,
            browser_epoch: new_epoch,
        })
    }
}
