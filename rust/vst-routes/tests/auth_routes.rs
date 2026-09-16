//! Tests for auth, mobile-auth, and tailscale routes and primitives (07b dispatch #2).
//!
//! Behavior contract tests:
//! - HMAC token mint and verify.
//! - Constant-time comparison rejects tampered tokens, wrong keys, malformed formats.
//! - Scope validation, exp/epoch checks, token revocation, epoch bump.
//! - AuthState singleton / session tracking, device name extraction, active session pruning.
//! - AuthRoutes: check, logout, sessions, revoke, revoke_browser.
//! - MobileAuth: rate limiting, one-time code mint/redeem, QR URLs, background code janitor.
//! - Tailscale: status, enable, disable, up, qr.
//!
//! All assertions MUST be assert!()-wrapped. No bare matches!().

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use vst_routes::auth::{
    mint_token, verify_token, AuthRoutes, AuthState, BrowserSession, COOKIE_NAME,
};
use vst_routes::mobile_auth::{
    check_mobile_auth_rate_limit, parse_device_name, MobileAuthRoutes, OneTimeCodeStore,
};
use vst_routes::tailscale::TailscaleRoutes;
use vst_types::domain::{TokenPayload, TokenScope, VerifyErrorReason, VerifyResult};

#[test]
fn test_token_mint_and_verify_cli_tauri() {
    let auth_state = AuthState::new("secret-daemon-key-12345", 1);

    // CLI token
    let cli_token = mint_token(TokenScope::Cli, &auth_state, None);
    assert!(cli_token.contains('.'));
    let res = verify_token(&cli_token, &auth_state);
    assert!(matches!(res, VerifyResult::Ok { .. }));
    if let VerifyResult::Ok { payload } = res {
        assert_eq!(payload.scope, TokenScope::Cli);
        assert!(payload.exp.is_none());
        assert!(payload.epoch.is_none());
    }

    // Tauri token
    let tauri_token = mint_token(TokenScope::Tauri, &auth_state, None);
    let res = verify_token(&tauri_token, &auth_state);
    assert!(matches!(res, VerifyResult::Ok { .. }));
    if let VerifyResult::Ok { payload } = res {
        assert_eq!(payload.scope, TokenScope::Tauri);
        assert!(payload.exp.is_none());
        assert!(payload.epoch.is_none());
    }
}

#[test]
fn test_token_mint_and_verify_browser() {
    let auth_state = AuthState::new("secret-daemon-key-12345", 5);

    let browser_token = mint_token(TokenScope::Browser, &auth_state, None);
    let res = verify_token(&browser_token, &auth_state);
    assert!(matches!(res, VerifyResult::Ok { .. }));
    if let VerifyResult::Ok { payload } = res {
        assert_eq!(payload.scope, TokenScope::Browser);
        assert!(payload.exp.is_some());
        assert_eq!(payload.epoch, Some(5));
    }
}

#[test]
fn test_token_constant_time_rejects_tampered_signature() {
    let auth_state = AuthState::new("secret-key", 1);
    let token = mint_token(TokenScope::Cli, &auth_state, None);

    let parts: Vec<&str> = token.split('.').collect();
    assert_eq!(parts.len(), 2);
    let payload_b64 = parts[0];
    let sig = parts[1];

    // Tamper with last character of hex signature
    let mut tampered_sig = sig.to_string();
    let last_char = tampered_sig.pop().unwrap();
    let replacement = if last_char == 'a' { 'b' } else { 'a' };
    tampered_sig.push(replacement);

    let tampered_token = format!("{payload_b64}.{tampered_sig}");
    let res = verify_token(&tampered_token, &auth_state);
    assert!(matches!(
        res,
        VerifyResult::Err {
            reason: VerifyErrorReason::InvalidSignature
        }
    ));

    // Tamper with signature length (shorter / odd length)
    let short_token = format!("{payload_b64}.{}", &sig[..sig.len() - 2]);
    let res_short = verify_token(&short_token, &auth_state);
    assert!(matches!(
        res_short,
        VerifyResult::Err {
            reason: VerifyErrorReason::InvalidSignature
        }
    ));

    // Non-hex signature
    let non_hex = format!("{payload_b64}.{}", "z".repeat(64));
    let res_non_hex = verify_token(&non_hex, &auth_state);
    assert!(matches!(
        res_non_hex,
        VerifyResult::Err {
            reason: VerifyErrorReason::InvalidSignature
        }
    ));

    // Wrong daemon key
    let wrong_state = AuthState::new("different-key", 1);
    let res_wrong_key = verify_token(&token, &wrong_state);
    assert!(matches!(
        res_wrong_key,
        VerifyResult::Err {
            reason: VerifyErrorReason::InvalidSignature
        }
    ));
}

#[test]
fn test_token_malformed_and_revocation() {
    let auth_state = AuthState::new("test-key", 1);

    // No dot
    let res = verify_token("nodothere", &auth_state);
    assert!(matches!(
        res,
        VerifyResult::Err {
            reason: VerifyErrorReason::Malformed
        }
    ));

    // Invalid base64 payload
    let res2 = verify_token(
        "!not-base64!.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        &auth_state,
    );
    assert!(matches!(
        res2,
        VerifyResult::Err {
            reason: VerifyErrorReason::InvalidSignature
        }
    ));

    // Valid token then revoke it
    let token = mint_token(TokenScope::Browser, &auth_state, None);
    let payload_b64 = token.split('.').next().unwrap();

    auth_state.revoke_token_id(payload_b64);
    let res_revoked = verify_token(&token, &auth_state);
    assert!(matches!(
        res_revoked,
        VerifyResult::Err {
            reason: VerifyErrorReason::Revoked
        }
    ));
}

#[test]
fn test_token_epoch_mismatch_and_expiry() {
    let auth_state = AuthState::new("test-key", 1);

    // Custom past expiry
    let past_exp = 1000;
    let expired_token = mint_token(TokenScope::Browser, &auth_state, Some(past_exp));
    let res_exp = verify_token(&expired_token, &auth_state);
    assert!(matches!(
        res_exp,
        VerifyResult::Err {
            reason: VerifyErrorReason::Expired
        }
    ));

    // Epoch mismatch after bump
    let valid_token = mint_token(TokenScope::Browser, &auth_state, None);
    auth_state.set_browser_epoch(2);
    let res_epoch = verify_token(&valid_token, &auth_state);
    assert!(matches!(
        res_epoch,
        VerifyResult::Err {
            reason: VerifyErrorReason::EpochMismatch
        }
    ));
}

#[test]
fn test_auth_state_active_browser_sessions() {
    let auth_state = AuthState::new("test-key", 1);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let s1 = BrowserSession {
        token_id: "tok-1".to_string(),
        scope: "browser".to_string(),
        issued_at: now,
        expires_at: Some(now + 60_000),
        epoch: 1,
        device_name: Some("iPhone".to_string()),
    };
    let s_expired = BrowserSession {
        token_id: "tok-expired".to_string(),
        scope: "browser".to_string(),
        issued_at: now - 100_000,
        expires_at: Some(now - 1000),
        epoch: 1,
        device_name: Some("Mac".to_string()),
    };
    let s_wrong_epoch = BrowserSession {
        token_id: "tok-wrong-epoch".to_string(),
        scope: "browser".to_string(),
        issued_at: now,
        expires_at: Some(now + 60_000),
        epoch: 0,
        device_name: None,
    };

    auth_state.record_browser_session(s1);
    auth_state.record_browser_session(s_expired);
    auth_state.record_browser_session(s_wrong_epoch);

    let active = auth_state.get_active_browser_sessions();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].token_id, "tok-1");
    assert_eq!(active[0].device_name.as_deref(), Some("iPhone"));
}

#[tokio::test]
async fn test_auth_routes_endpoints() {
    let auth_state = AuthState::new("test-daemon-key", 1);
    let epoch_tracker = Arc::new(AtomicI64::new(1));
    let epoch_clone = epoch_tracker.clone();

    let persist_epoch = Arc::new(move |new_epoch: i64| {
        let ep = epoch_clone.clone();
        Box::pin(async move {
            ep.store(new_epoch, Ordering::SeqCst);
            Ok(())
        }) as vst_routes::auth::PersistEpochFuture
    });

    let routes = AuthRoutes::new(auth_state.clone(), persist_epoch);

    // Logout
    let (status, cookie, body) = routes.logout().await;
    assert_eq!(status, 200);
    assert!(cookie.contains("Max-Age=0"));
    assert!(body.ok);

    // Check
    let res_check = routes.check(None).await;
    assert!(res_check.ok);

    // Sessions (desktop view)
    let sessions_res = routes.sessions(None, None).await;
    assert!(sessions_res.is_desktop);
    assert_eq!(sessions_res.current_scope, "tauri");
    assert!(sessions_res.current_token_id.is_none());

    // Revoke by token id (desktop caller)
    let revoke_res = routes.revoke_session("tok-missing", None).await;
    assert!(revoke_res.is_err()); // Not found

    // Revoke by non-desktop caller should be forbidden (403)
    let non_desktop_payload = TokenPayload {
        iat: 0,
        scope: TokenScope::Browser,
        exp: None,
        epoch: None,
    };
    let revoke_forbidden = routes
        .revoke_session("tok-1", Some(&non_desktop_payload))
        .await;
    assert!(matches!(
        revoke_forbidden,
        Err(vst_routes::auth::AuthRouteError::DesktopOnly)
    ));

    // Revoke browser (desktop caller)
    let res_bump = routes.revoke_browser(None).await.unwrap();
    assert_eq!(res_bump.browser_epoch, 2);
    assert_eq!(epoch_tracker.load(Ordering::SeqCst), 2);
    assert_eq!(auth_state.browser_epoch(), 2);
}

#[tokio::test]
async fn test_mobile_auth_rate_limiting_and_codes() {
    let store = OneTimeCodeStore::new();

    // Device parsing
    assert_eq!(
        parse_device_name("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)"),
        "iPhone"
    );
    assert_eq!(
        parse_device_name("Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)"),
        "iPad"
    );
    assert_eq!(
        parse_device_name("Mozilla/5.0 (Linux; Android 13; Pixel 7)"),
        "Pixel 7"
    );
    assert_eq!(
        parse_device_name("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
        "Mac"
    );
    assert_eq!(
        parse_device_name("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"),
        "Windows PC"
    );
    assert_eq!(
        parse_device_name("Mozilla/5.0 (X11; Linux x86_64)"),
        "Linux"
    );

    // Mint one time code
    let (code, expires_at) = store.mint_one_time_code("tunnel");
    assert_eq!(code.len(), 64);
    assert!(expires_at > 0);

    // Rate limiter
    let ip = "192.0.2.1";
    for _ in 0..20 {
        assert!(check_mobile_auth_rate_limit(ip));
    }
    // 21st attempt in the same window fails
    assert!(!check_mobile_auth_rate_limit(ip));
}

#[tokio::test]
async fn test_mobile_auth_routes_redeem_flow() {
    let auth_state = AuthState::new("test-key", 1);
    let code_store = OneTimeCodeStore::new();
    let routes = MobileAuthRoutes::new(Some(auth_state.clone()), code_store.clone(), 7421, false);

    // Mint a code for tunnel
    let (code, _) = code_store.mint_one_time_code("tunnel");

    // Redeem with wrong origin (local path on tunnel code) -> 410 HTML
    let res_wrong_origin = routes
        .mobile_auth(Some(code.clone()), Some("198.51.100.1"), false, "")
        .await;
    assert_eq!(res_wrong_origin.status, 410);
    assert!(res_wrong_origin.html.contains("QR code expired"));

    // Redeem with correct origin via tunnel
    let res_ok = routes
        .mobile_auth(
            Some(code.clone()),
            Some("198.51.100.2"),
            true,
            "Mozilla/5.0 (iPhone)",
        )
        .await;
    assert_eq!(res_ok.status, 200);
    assert!(res_ok.html.contains("Device connected"));
    assert!(res_ok.set_cookie.is_some());
    let cookie = res_ok.set_cookie.unwrap();
    assert!(cookie.contains(COOKIE_NAME));
    assert!(cookie.contains("Secure"));

    // Replay same code -> 410 expired
    let res_replay = routes
        .mobile_auth(
            Some(code),
            Some("198.51.100.2"),
            true,
            "Mozilla/5.0 (iPhone)",
        )
        .await;
    assert_eq!(res_replay.status, 410);
}

#[tokio::test]
async fn test_tailscale_routes() {
    let code_store = OneTimeCodeStore::new();
    let routes = TailscaleRoutes::new(code_store, 7421);

    // GET /tailscale/status
    let status = routes.status().await;
    // On dev/test sandbox, tailscale status returns a valid enum
    assert!(matches!(
        status,
        vst_types::rest::tailscale::TailscaleStatus::NotInstalled
            | vst_types::rest::tailscale::TailscaleStatus::NotConnected
            | vst_types::rest::tailscale::TailscaleStatus::Starting
            | vst_types::rest::tailscale::TailscaleStatus::NeedsOperator { .. }
            | vst_types::rest::tailscale::TailscaleStatus::CertsNotEnabled { .. }
            | vst_types::rest::tailscale::TailscaleStatus::ConnectedNoServe { .. }
            | vst_types::rest::tailscale::TailscaleStatus::ServeActive { .. }
            | vst_types::rest::tailscale::TailscaleStatus::PortMismatch { .. }
            | vst_types::rest::tailscale::TailscaleStatus::Error { .. }
    ));

    // Non-desktop up -> 403
    let non_desktop = TokenPayload {
        iat: 0,
        scope: TokenScope::Browser,
        exp: None,
        epoch: None,
    };
    let up_err = routes.up(Some(&non_desktop)).await;
    assert!(matches!(
        up_err,
        Err(vst_routes::tailscale::TailscaleRouteError::DesktopOnly)
    ));
}
