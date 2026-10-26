//! The outgoing daemon's side of a restart: snapshot the DB, write the handoff
//! and (when a binary was replaced) start the rollback watcher.

use std::path::PathBuf;
use std::sync::Arc;

use vst_routes::auth::AuthState;
use vst_store::StoreHandle;

use crate::update::watch::WatchArgs;
use crate::update::{handoff, paths, UpdateService};

/// Everything [`prepare_restart`] needs from the running daemon.
pub struct RestartCtx {
    pub store: StoreHandle,
    pub auth: AuthState,
    pub update: Arc<UpdateService>,
    pub vst_home: PathBuf,
    /// Captured at boot (a replaced exe reads `(deleted)` later on Linux).
    pub boot_exe: PathBuf,
    pub boot_id: String,
    pub port: u16,
}

/// Run after the drain, before the lock is released. Every step is non-fatal:
/// worst case the restart is fresh (no handoff) or unwatched (no rollback).
/// Returns the handoff nonce for the successor (`None` = the write failed).
pub async fn prepare_restart(ctx: &RestartCtx) -> Option<String> {
    let prev_db = paths::prev_db_snapshot(&ctx.vst_home);
    if let Err(e) = ctx.store.snapshot_to(&prev_db).await {
        tracing::warn!(err = %e, "failed to snapshot database before restart (non-fatal)");
        // `snapshot_to` deletes the old snapshot first, so a failed
        // VACUUM leaves none. Make that explicit (a partial file must never be
        // restored); the watcher skips the DB restore when the path is absent.
        let _ = std::fs::remove_file(&prev_db);
    }

    let nonce = match handoff::write(
        &ctx.vst_home,
        &ctx.auth.export_handoff(),
        ctx.port,
        &ctx.boot_id,
    ) {
        Ok(nonce) => Some(nonce),
        Err(e) => {
            tracing::error!(err = %e, "failed to write restart handoff file (non-fatal, session will restart fresh)");
            None
        }
    };

    // A pending restart means a binary was replaced: watch the successor.
    if let Some(pending) = ctx.update.snapshot().restart_pending {
        let bin_dir = ctx.boot_exe.parent().unwrap_or(&ctx.vst_home);
        let prev_vst = bin_dir.join(".vst.prev");
        if prev_vst.exists() {
            let watch = WatchArgs {
                expect_version: pending.version,
                port: ctx.port,
                pid: std::process::id(),
                bin_dir: bin_dir.to_path_buf(),
                vst_home: ctx.vst_home.clone(),
                db_snapshot: prev_db,
                old_boot_id: ctx.boot_id.clone(),
                nonce: nonce.clone(),
            };
            if let Err(e) = watch.spawn(&prev_vst) {
                tracing::warn!(err = %e, "failed to spawn rollback watcher (non-fatal, proceeding without watcher)");
            }
        } else {
            tracing::warn!("no .vst.prev binary found; proceeding without rollback watcher");
        }
    }
    nonce
}
