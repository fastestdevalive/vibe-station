//! Browser-origin policy for REST, CORS and the WebSocket upgrade.
//!
//! A request carrying an `Origin` header is accepted only if the origin is
//!
//! 1. one of a small set of **exact** extra origins (the Tauri webviews, plus
//!    whatever `VST_ALLOWED_ORIGINS` adds for e.g. the Vite dev server), or
//! 2. **same-origin** with the `Host` the request arrived on (`Origin`'s
//!    authority equals `Host`, host:port included), and that host is one we
//!    expect to be addressed by (loopback, private LAN, Tailscale, tunnel).
//!
//! Matching the whole authority — port included — is what stops another web
//! page on `http://localhost:<other-port>` from riding a logged-in browser's
//! cookie: `SameSite` cannot tell localhost ports apart, this check can. The
//! host-name check on top of it rejects DNS-rebinding pages (`evil.example`
//! resolving to 127.0.0.1 sends `Host: evil.example`).
//!
//! Requests without an `Origin` (curl, the `vst` CLI, same-origin GETs) are not
//! judged here; they still need a valid token.

use std::net::IpAddr;

/// Origins that are always allowed regardless of `Host` (exact match).
const FIXED_EXTRA_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

/// Env var: comma-separated extra exact origins, e.g. `http://localhost:5173`
/// when the web UI runs on the Vite dev server (its proxy rewrites `Host`, so
/// the origin is not same-origin from the daemon's point of view).
pub const ALLOWED_ORIGINS_ENV: &str = "VST_ALLOWED_ORIGINS";

#[derive(Clone, Debug, Default)]
pub struct OriginPolicy {
    extra: Vec<String>,
}

impl OriginPolicy {
    pub fn new(extra: impl IntoIterator<Item = String>) -> Self {
        let extra = FIXED_EXTRA_ORIGINS
            .iter()
            .map(|s| s.to_string())
            .chain(extra.into_iter().map(|s| normalize(&s)))
            .filter(|s| !s.is_empty())
            .collect();
        Self { extra }
    }

    pub fn from_env() -> Self {
        let extra = std::env::var(ALLOWED_ORIGINS_ENV)
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .collect::<Vec<_>>();
        Self::new(extra)
    }

    /// Host-name-only variant for `VST_NO_AUTH` sandbox builds, where the Vite
    /// proxy rewrites `Host` and there is no token to fall back on: accept an
    /// exact extra or any origin whose host is one we expect (loopback, LAN,
    /// tailnet, tunnel) on any port — but never an arbitrary website.
    pub fn origin_host_allowed(&self, origin: &str) -> bool {
        let origin = normalize(origin);
        if self.extra.contains(&origin) {
            return true;
        }
        match origin.split_once("://") {
            Some((scheme, authority)) => {
                (scheme == "http" || scheme == "https")
                    && !authority.contains(['/', '@', '?', '#'])
                    && host_name_allowed(authority)
            }
            None => false,
        }
    }

    /// `host` is the request's `Host` header, if any.
    pub fn origin_allowed(&self, origin: &str, host: Option<&str>) -> bool {
        let origin = normalize(origin);
        if self.extra.contains(&origin) {
            return true;
        }
        let Some((scheme, authority)) = origin.split_once("://") else {
            return false;
        };
        if scheme != "http" && scheme != "https" {
            return false;
        }
        if authority.is_empty() || authority.contains(['/', '@', '?', '#']) {
            return false;
        }
        let Some(host) = host.map(|h| h.trim().to_ascii_lowercase()) else {
            return false;
        };
        authority == host && host_name_allowed(&host)
    }
}

fn normalize(s: &str) -> String {
    s.trim().trim_end_matches('/').to_ascii_lowercase()
}

/// Strip an optional `:port` (and IPv6 brackets) from a `Host`/authority value.
fn host_name(authority: &str) -> &str {
    if let Some(rest) = authority.strip_prefix('[') {
        return rest.split(']').next().unwrap_or("");
    }
    authority.split(':').next().unwrap_or("")
}

/// Is `authority` (`host[:port]`) a host this daemon expects to be addressed as?
/// Loopback, private/CGNAT IPv4 (LAN, Tailscale), ULA/link-local IPv6,
/// `*.ts.net` and `*.trycloudflare.com`.
pub fn host_name_allowed(authority: &str) -> bool {
    let host = host_name(authority);
    if host == "localhost" || host == "tauri.localhost" {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if ip.is_loopback() {
            return true;
        }
        return match ip {
            IpAddr::V4(v4) => {
                let o = v4.octets();
                o[0] == 10
                    || (o[0] == 172 && (16..=31).contains(&o[1]))
                    || (o[0] == 192 && o[1] == 168)
                    || (o[0] == 100 && (64..=127).contains(&o[1]))
            }
            IpAddr::V6(v6) => {
                let s = v6.segments();
                (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80
            }
        };
    }
    host.ends_with(".trycloudflare.com") || host.ends_with(".ts.net")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p() -> OriginPolicy {
        OriginPolicy::new(["http://localhost:5173".to_string()])
    }

    #[test]
    fn same_origin_loopback_allowed() {
        assert!(p().origin_allowed("http://localhost:7421", Some("localhost:7421")));
        assert!(p().origin_allowed("http://127.0.0.1:7421", Some("127.0.0.1:7421")));
        assert!(p().origin_allowed("http://[::1]:7421", Some("[::1]:7421")));
    }

    #[test]
    fn other_localhost_port_rejected() {
        assert!(!p().origin_allowed("http://localhost:3000", Some("localhost:7421")));
        assert!(!p().origin_allowed("http://127.0.0.1:9999", Some("127.0.0.1:7421")));
        // different loopback spelling is a different origin too
        assert!(!p().origin_allowed("http://localhost:7421", Some("127.0.0.1:7421")));
    }

    #[test]
    fn missing_host_rejected() {
        assert!(!p().origin_allowed("http://localhost:7421", None));
    }

    #[test]
    fn dns_rebinding_host_rejected() {
        assert!(!p().origin_allowed("http://evil.example:7421", Some("evil.example:7421")));
    }

    #[test]
    fn tunnel_lan_and_tailscale_same_origin_allowed() {
        assert!(p().origin_allowed(
            "https://abc.trycloudflare.com",
            Some("abc.trycloudflare.com")
        ));
        assert!(p().origin_allowed("https://box.tail1.ts.net", Some("box.tail1.ts.net")));
        assert!(p().origin_allowed("http://192.168.1.5:7421", Some("192.168.1.5:7421")));
        assert!(p().origin_allowed("http://100.100.1.1:7421", Some("100.100.1.1:7421")));
    }

    #[test]
    fn lan_origin_against_loopback_host_rejected() {
        assert!(!p().origin_allowed("http://192.168.1.5:7421", Some("localhost:7421")));
    }

    #[test]
    fn extra_origins_exact_only() {
        assert!(p().origin_allowed("tauri://localhost", Some("127.0.0.1:7421")));
        assert!(p().origin_allowed("http://tauri.localhost", Some("127.0.0.1:7421")));
        assert!(p().origin_allowed("http://localhost:5173", Some("127.0.0.1:7421")));
        assert!(!p().origin_allowed("http://localhost:5174", Some("127.0.0.1:7421")));
    }

    #[test]
    fn host_only_variant_allows_any_port_but_not_websites() {
        assert!(p().origin_host_allowed("http://localhost:3000"));
        assert!(p().origin_host_allowed("http://192.168.1.5:5174"));
        assert!(!p().origin_host_allowed("https://evil.com"));
        assert!(!p().origin_host_allowed("null"));
    }

    #[test]
    fn malformed_origins_rejected() {
        for o in [
            "null",
            "localhost:7421",
            "ftp://localhost:7421",
            "http://localhost:7421/x",
            "http://a@localhost:7421",
        ] {
            assert!(!p().origin_allowed(o, Some("localhost:7421")), "{o}");
        }
    }
}
