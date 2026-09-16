#![forbid(unsafe_code)]

//! Daemon entry point — ports `daemon/src/main.ts`.
//!
//! Startup sequence (mirrors TS):
//! 1. Install process guards (EPIPE/unhandled-rejection backstop).
//! 2. Acquire `~/.vibe-station/.daemon.lock` (PID-checked).
//! 3. Best-effort: setup vst environment, install harness skill dirs, patch shell configs.
//! 4. `store.migrate_manifests()` — one-time JSON → SQLite migration (idempotent).
//! 5. `recover_not_started_sessions` + `sweep_direct_pty_sessions_on_boot`.
//! 6. Determine port (`VST_PORT` env var or find free port starting from 7421).
//! 7. Read existing `config.json` for `browserEpoch`.
//! 8. Generate fresh `daemonToken` (ring CSPRNG, never persisted).
//! 9. Build `AuthState`, mint `cliToken` + `tauriToken`.
//! 10. Write `config.json` (mode 0o600).
//! 11. Best-effort: initialize user skill catalog from persisted settings.
//! 12. Best-effort: cloudflared restore-on-boot (sweep orphans + re-enable if was enabled).
//! 13. Tailscale port-drift check.
//! 14. Start lifecycle + PR pollers.
//! 15. Register SIGINT/SIGTERM handlers.
//! 16. Bind and serve.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use tokio::signal::unix::{signal, SignalKind};

use vst_agents::user_skill_catalog;
use vst_git::paths::Paths;
use vst_git::recover::{recover_not_started_sessions, sweep_direct_pty_sessions_on_boot};
use vst_git::DirectPtyRegistry;
use vst_lifecycle::cloudflared;
use vst_lifecycle::lifecycle::LifecyclePollerHandle;
use vst_lifecycle::pr_poller::PrPollerHandle;
use vst_lifecycle::tailscale_serve;
use vst_proc::tmux::Tmux;
use vst_routes::auth::{mint_token, AuthState};
use vst_routes::settings::default_skill_paths;
use vst_store::StoreHandle;
use vst_types::domain::TokenScope;
use vst_types::events::Broadcaster;

use vst_daemon::env_setup::{
    install_harness_skill_dirs, patch_shell_configs, setup_vst_environment,
};
use vst_daemon::lock::{acquire_lock, release_lock};
use vst_daemon::port::{find_free_port, DEFAULT_PORT};
use vst_daemon::server::{build_app, BuildServerOptions};

// ─── config.json I/O ─────────────────────────────────────────────────────────

/// Read `config.json` as a raw JSON object. Returns an empty object on any
/// error (missing file, parse failure) so callers can always `.get("key")`.
async fn read_raw_config(config_path: &PathBuf) -> serde_json::Value {
    match tokio::fs::read_to_string(config_path).await {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    }
}

/// Write `config.json` (mode 0o600) — preserves existing user-facing fields.
///
/// `daemonToken` is **never** written to disk — only the pre-minted
/// `cliToken`/`tauriToken` and the `browserEpoch` are persisted.
async fn write_config(
    config_path: &PathBuf,
    port: u16,
    cli_token: &str,
    browser_epoch: i64,
    tauri_token: &str,
    existing: &serde_json::Value,
) -> Result<()> {
    use std::io::Write;

    if let Some(parent) = config_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .context("create ~/.vibe-station")?;
    }

    // Merge over existing to preserve user settings (defaultProjectsDir, etc.).
    let mut cfg = existing.clone();
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert("port".into(), serde_json::json!(port));
        obj.insert("pid".into(), serde_json::json!(std::process::id()));
        obj.insert("startedAt".into(), serde_json::json!(chrono_now_iso()));
        obj.insert("cliToken".into(), serde_json::json!(cli_token));
        obj.insert("tauriToken".into(), serde_json::json!(tauri_token));
        obj.insert("browserEpoch".into(), serde_json::json!(browser_epoch));
    } else {
        // existing was not a JSON object — shouldn't happen (read_raw_config always
        // returns an object), but rebuild defensively.
        cfg = serde_json::json!({
            "port": port,
            "pid": std::process::id(),
            "startedAt": chrono_now_iso(),
            "cliToken": cli_token,
            "tauriToken": tauri_token,
            "browserEpoch": browser_epoch,
        });
    }
    // Never write daemonToken.

    let out = serde_json::to_string_pretty(&cfg).context("serialize config")?;

    // Write atomically via temp file + rename.
    let tmp_path = config_path.with_extension("json.tmp");
    tokio::task::spawn_blocking({
        let out = out.clone();
        let tmp = tmp_path.clone();
        let dest = config_path.clone();
        move || -> Result<()> {
            {
                let mut f = std::fs::File::create(&tmp).context("create config tmp")?;
                f.write_all(out.as_bytes()).context("write config tmp")?;
                std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
                    .context("chmod config tmp")?;
            }
            std::fs::rename(&tmp, &dest).context("rename config")?;
            // Ensure correct perms even if file pre-existed.
            std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o600))
                .context("chmod config")?;
            Ok(())
        }
    })
    .await
    .context("spawn_blocking write_config")??;

    Ok(())
}

fn chrono_now_iso() -> String {
    // Use SystemTime without chrono dep.
    use std::time::SystemTime;
    let dur = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    // RFC 3339 / ISO 8601 basic formatting (UTC).
    let (y, mo, d, h, mi, s) = epoch_to_ymd_hms(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn epoch_to_ymd_hms(secs: u64) -> (u32, u32, u32, u32, u32, u32) {
    let s = secs % 60;
    let mins = secs / 60;
    let mi = mins % 60;
    let hours = mins / 60;
    let h = hours % 24;
    let days = hours / 24 + 719_468; // shift to civil epoch
    let era = days / 146_097;
    let doe = days % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    (y as u32, mo as u32, d as u32, h as u32, mi as u32, s as u32)
}

// ─── Token generation ────────────────────────────────────────────────────────

/// Generate a fresh 32-byte random hex string using the `ring` CSPRNG.
fn gen_daemon_token() -> Result<String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let rng = SystemRandom::new();
    let mut bytes = [0u8; 32];
    rng.fill(&mut bytes)
        .map_err(|_| anyhow::anyhow!("ring: failed to generate random bytes"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

// ─── Cloudflared restore-on-boot ─────────────────────────────────────────────

/// Ports `cloudflared.restoreOnBoot(tunnelPort)` from TS.
///
/// The Rust `cloudflared` module documents `restore_on_boot` in its module
/// comment but the function was not implemented yet at this dispatch.
/// We implement the equivalent inline here:
/// - Sweep any orphaned `cloudflared` processes.
/// - If the store says the tunnel was `enabled`, re-launch it on `tunnel_port`.
async fn cloudflared_restore_on_boot(tunnel_port: u16, store: &StoreHandle) {
    // Sweep orphan processes unconditionally.
    if let Err(e) = cloudflared::sweep_orphans().await {
        tracing::warn!("[vst] cloudflared sweep_orphans failed (non-fatal): {e}");
    }

    // Re-enable if it was previously enabled.
    match cloudflared::get_state(store).await {
        Ok(state) if state.enabled => {
            tracing::info!(
                "[vst] cloudflared was enabled — restoring tunnel on port {tunnel_port}"
            );
            match cloudflared::enable(tunnel_port, store).await {
                Ok(url) => tracing::info!("[vst] cloudflared tunnel restored: {url}"),
                Err(e) => tracing::warn!("[vst] cloudflared restore failed (non-fatal): {e}"),
            }
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("[vst] cloudflared get_state failed (non-fatal): {e}"),
    }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    // ── Tracing ──────────────────────────────────────────────────────────────
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // ── Paths ────────────────────────────────────────────────────────────────
    let paths = Paths::default_home();
    let vst_home = paths.vst_home().clone();
    let lock_path = vst_home.join(".daemon.lock");
    let config_path = vst_home.join("config.json");

    // ── Lock ─────────────────────────────────────────────────────────────────
    // Single-daemon invariant: acquireLock() → this also covers vibe-station.db
    // since it lives in the same directory. No additional DB locking needed.
    acquire_lock(&lock_path)
        .await
        .context("acquire daemon lock")?;

    // ── Best-effort environment setup ─────────────────────────────────────────
    // Write ~/.vibe-station/bin/vst shim, SKILL.md, shell configs.
    // Non-fatal: failures are logged, never abort startup.
    if let Err(e) = async {
        setup_vst_environment(&vst_home).await;
        install_harness_skill_dirs(&vst_home).await;
        patch_shell_configs(&vst_home).await;
        Ok::<_, anyhow::Error>(())
    }
    .await
    {
        tracing::error!("[vst] setupVstEnvironment failed (non-fatal): {e}");
    }

    // ── Manifest migration ───────────────────────────────────────────────────
    // One-time JSON → SQLite migration (idempotent after first successful boot).
    let db_path = vst_home.join("vibe-station.db");
    let store = StoreHandle::open(&db_path).context("open vibe-station.db")?;
    let projects_dir = vst_home.join("projects");
    if let Err(e) = store.migrate_manifests(&projects_dir).await {
        tracing::warn!("[vst] manifest migration failed (non-fatal): {e}");
    }

    // ── Boot recovery ─────────────────────────────────────────────────────────
    let tmux = Tmux::new();
    let direct_pty = DirectPtyRegistry::new();
    recover_not_started_sessions(&store, &tmux, &direct_pty, &paths).await;
    sweep_direct_pty_sessions_on_boot(&store, &paths).await;

    // ── Port ─────────────────────────────────────────────────────────────────
    let port = match std::env::var("VST_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|&p| p > 0)
    {
        Some(p) => p,
        None => find_free_port(DEFAULT_PORT).context("find free port")?,
    };

    // ── Auth state ────────────────────────────────────────────────────────────
    let existing_config = read_raw_config(&config_path).await;
    let browser_epoch = existing_config
        .get("browserEpoch")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    // Fresh daemonToken in memory on every startup — NEVER persisted.
    // All existing browser/CLI/Tauri sessions become invalid on restart.
    let daemon_token = gen_daemon_token().context("generate daemon token")?;
    let auth_state = AuthState::new(daemon_token.clone(), browser_epoch);

    // Print the browser login password so the operator can authenticate.
    tracing::info!("[vst] Browser login password: {daemon_token}");
    println!("[vst] Browser login password: {daemon_token}");

    // Pre-mint CLI + Tauri tokens and write to config.json.
    let cli_token = mint_token(TokenScope::Cli, &auth_state, None);
    let tauri_token = mint_token(TokenScope::Tauri, &auth_state, None);

    write_config(
        &config_path,
        port,
        &cli_token,
        browser_epoch,
        &tauri_token,
        &existing_config,
    )
    .await
    .context("write config.json")?;

    let no_auth = matches!(
        std::env::var("VST_NO_AUTH").as_deref(),
        Ok("1") | Ok("true")
    );
    if no_auth {
        tracing::warn!(
            "⚠  VST_NO_AUTH set — authentication is DISABLED. \
             Do not expose this daemon to untrusted networks."
        );
    } else {
        tracing::info!("CLI token written to {}", config_path.display());
    }

    // ── Skill catalog ─────────────────────────────────────────────────────────
    // Initialize from persisted settings so the catalog is populated on a
    // fresh install without requiring the user to open Skills settings first.
    // Best-effort: never abort startup on failure.
    {
        let skill_dir = vst_home.join("skill");
        let mut all_paths = default_skill_paths();
        all_paths.push(skill_dir.to_string_lossy().to_string());
        if let Err(e) = async {
            // Read skillPaths from persisted config if present.
            let custom: Vec<String> = existing_config
                .get("skillPaths")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            if !custom.is_empty() {
                all_paths = custom;
                all_paths.push(skill_dir.to_string_lossy().to_string());
            }
            user_skill_catalog::set_skill_paths(&all_paths).await;
            Ok::<_, anyhow::Error>(())
        }
        .await
        {
            tracing::error!("Failed to initialize skill catalog (non-fatal): {e}");
        }
    }

    // ── Cloudflared restore-on-boot ───────────────────────────────────────────
    // tunnel_port = daemon_port + 1 (mirrors resolveTunnelPort in TS).
    // Overridable via VST_TUNNEL_PORT env var (same as mobile_auth.rs).
    let tunnel_port: u16 = std::env::var("VST_TUNNEL_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| port.saturating_add(1));
    cloudflared_restore_on_boot(tunnel_port, &store).await;

    // ── Tailscale port-drift check ────────────────────────────────────────────
    // Log a warning if a serve rule exists but targets a different port.
    // Does NOT auto-fix — the UI surfaces the same condition as `port_mismatch`.
    match tailscale_serve::get_status(port).await {
        Ok(vst_lifecycle::tailscale_serve::TailscaleStatus::PortMismatch { expected, actual }) => {
            tracing::warn!(
                "[vst] Tailscale serve rule points at port {expected}, \
                 but this daemon is on {actual}. \
                 Enable will repair it, or set VST_PORT={expected} to match."
            );
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!("[vst] Tailscale serve status unavailable at boot (non-fatal): {e}");
        }
    }

    // ── Build Axum router ─────────────────────────────────────────────────────
    let broadcaster = Broadcaster::new(256);
    let json_registry = Arc::new(vst_agents::json_agent_registry::JsonAgentRegistry::<
        vst_agents::json_agent_session::JsonAgentSession,
    >::new());

    // `persistEpoch` callback: re-writes config.json when the browser epoch
    // bumps (e.g. POST /auth/logout/all).
    let persist_epoch_config_path = config_path.clone();
    let persist_epoch_cli_token = cli_token.clone();
    let persist_epoch_tauri_token = tauri_token.clone();
    let persist_epoch_existing = existing_config.clone();
    let persist_epoch_fn: vst_routes::auth::PersistEpochFn = Arc::new(move |new_epoch| {
        let config_path = persist_epoch_config_path.clone();
        let cli_token = persist_epoch_cli_token.clone();
        let tauri_token = persist_epoch_tauri_token.clone();
        let existing = persist_epoch_existing.clone();
        Box::pin(async move {
            write_config(
                &config_path,
                port,
                &cli_token,
                new_epoch,
                &tauri_token,
                &existing,
            )
            .await
            .map_err(|e| e.to_string())
        })
    });

    let dist_path: Option<PathBuf> = std::env::var("VST_DIST_PATH")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            // Resolve relative to the current executable (prod layout: dist/ sibling to vst-daemon).
            std::env::current_exe().ok().and_then(|exe| {
                let candidate = exe.parent()?.join("dist");
                if candidate.is_dir() {
                    Some(candidate)
                } else {
                    None
                }
            })
        });

    let router = build_app(BuildServerOptions {
        port,
        auth_state: Some(auth_state.clone()),
        no_auth,
        dist_path,
        persist_epoch: Some(persist_epoch_fn),
        store: store.clone(),
        broadcaster: broadcaster.clone(),
        json_registry,
        tmux: tmux.clone(),
        started_at: Instant::now(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        paths: paths.clone(),
    });

    // ── Pollers ───────────────────────────────────────────────────────────────
    let lifecycle_poller = Arc::new(LifecyclePollerHandle::new(
        store.clone(),
        broadcaster.clone(),
    ));
    let lifecycle_handle = lifecycle_poller.clone().start();

    let pr_poller = Arc::new(PrPollerHandle::new(store.clone(), broadcaster.clone()));
    let pr_handle = pr_poller.clone().start();

    // ── Graceful shutdown ─────────────────────────────────────────────────────
    let lock_path_for_shutdown = lock_path.clone();
    let store_for_shutdown = store.clone();
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let shutdown_notify = shutdown.clone();

    // Register SIGINT + SIGTERM.
    tokio::spawn(async move {
        let mut sigint = signal(SignalKind::interrupt()).expect("SIGINT handler");
        let mut sigterm = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = sigint.recv() => tracing::info!("\nReceived SIGINT; shutting down…"),
            _ = sigterm.recv() => tracing::info!("\nReceived SIGTERM; shutting down…"),
        }
        // Abort pollers.
        lifecycle_handle.abort();
        pr_handle.abort();
        // Kill cloudflared but preserve `enabled` flag so restore_on_boot
        // can re-launch it on next restart (Decision 3 / tunnel-persistence).
        let _ = cloudflared::shutdown_kill(&store_for_shutdown).await;
        release_lock(&lock_path_for_shutdown).await;
        shutdown_notify.notify_one();
    });

    // ── Bind and serve ────────────────────────────────────────────────────────
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .with_context(|| format!("bind 0.0.0.0:{port}"))?;

    tracing::info!("vst daemon listening on http://0.0.0.0:{port}");
    println!("vst daemon listening on http://0.0.0.0:{port}");

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown.notified().await;
    })
    .await
    .context("axum serve")?;

    release_lock(&lock_path).await;
    Ok(())
}
