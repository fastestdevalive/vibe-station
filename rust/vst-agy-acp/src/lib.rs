#![forbid(unsafe_code)]
//! `vst-agy-acp` — single source of truth for the openab `agy-acp` adapter
//! binary (path resolution, state-dir, availability).
//!
//! `agy-acp` is a standalone binary compiled from the vendored openab submodule
//! (`rust/vendor/openab/agy-acp`) and spawned by the daemon over stdio ACP. This
//! crate owns *how the harness locates that binary and its state store*, so the
//! plugin (`vst-agents`), the daemon doctor (`vst-daemon`), and the CLI doctor
//! (`vst-cli`) all agree.
//!
//! Binary resolution order (see [`agy_acp_bin`]):
//!   1. `AGY_ACP_BIN` env override
//!   2. `agy-acp` next to the current executable (Tauri sidecar layout)
//!   3. `agy-acp` on PATH (dev convenience)
//!
//! State store lives under `~/.vibe-station/agy-acp/` (NOT the openab default
//! `~/.openab/agy-acp` nor the legacy npm adapter's `~/.agy-acp`), owned by the
//! harness. The adapter is pointed at it via the `AGY_ACP_STATE_DIR` env var;
//! [`agy_acp_sessions_path`] reads the same store the adapter writes, so the
//! two can never drift.

use std::path::PathBuf;

/// Name of the adapter binary.
pub const AGY_ACP_BIN_NAME: &str = "agy-acp";

/// Env var for the explicit adapter binary path override.
pub const AGY_ACP_BIN_ENV: &str = "AGY_ACP_BIN";

/// Env var the adapter reads for its state directory (patched openab build).
pub const AGY_ACP_STATE_DIR_ENV: &str = "AGY_ACP_STATE_DIR";

/// Resolve the `agy-acp` binary path.
///
/// Order: `AGY_ACP_BIN` env → `agy-acp` next to `current_exe()` (Tauri sidecar
/// layout) → `agy-acp` on PATH. Returns `None` when none resolve.
pub fn agy_acp_bin() -> Option<PathBuf> {
    if let Ok(p) = std::env::var(AGY_ACP_BIN_ENV) {
        let p = p.trim();
        if !p.is_empty() {
            let pb = PathBuf::from(p);
            // Only trust it if it actually resolves to a file (a dangling
            // AGY_ACP_BIN — e.g. a docker mount of an unbuilt binary — must
            // not be reported as available).
            if pb.is_file() {
                return Some(pb);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let sidecar = exe.with_file_name(AGY_ACP_BIN_NAME);
        if sidecar.is_file() {
            return Some(sidecar);
        }
        #[cfg(windows)]
        {
            let sidecar_exe = exe.with_file_name(format!("{AGY_ACP_BIN_NAME}.exe"));
            if sidecar_exe.is_file() {
                return Some(sidecar_exe);
            }
        }
    }
    if which(AGY_ACP_BIN_NAME).is_some() {
        return Some(PathBuf::from(AGY_ACP_BIN_NAME));
    }
    None
}

/// Whether an `agy-acp` binary is available (for doctor checks).
pub fn agy_acp_available() -> bool {
    agy_acp_bin().is_some()
}

/// `~/.vibe-station/agy-acp` — the state directory owned by the harness.
///
/// Honors the `AGY_ACP_STATE_DIR` env override first (mirroring exactly what
/// the adapter reads, so the harness and the adapter can never point at
/// different stores; also a clean seam for tests), else `$HOME/.vibe-station/agy-acp`.
pub fn agy_acp_state_dir() -> PathBuf {
    if let Ok(d) = std::env::var(AGY_ACP_STATE_DIR_ENV) {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".vibe-station").join("agy-acp")
}

/// `~/.vibe-station/agy-acp/sessions.json` — the adapter's session store.
///
/// This is the file the adapter writes (via `AGY_ACP_STATE_DIR`) and the
/// native-chat-id bridge reads — one path, shared, so they can't drift.
pub fn agy_acp_sessions_path() -> PathBuf {
    agy_acp_state_dir().join("sessions.json")
}

/// The `AGY_ACP_STATE_DIR` env value to hand the adapter so it writes the same
/// store [`agy_acp_sessions_path`] reads.
pub fn agy_acp_state_dir_env_value() -> String {
    agy_acp_state_dir().to_string_lossy().into_owned()
}

/// Read the adapter's persisted store, keyed by ACP session id →
/// `{ conversation_id, last_step_idx, model_id }` (openab `persist_session`
/// shape). Returns `None` if missing/unreadable.
pub fn read_sessions_store() -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(agy_acp_sessions_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Read the native `conversation_id` bound to an ACP session id from the store.
///
/// openab's `StoredSession` serializes `conversation_id` (snake_case — see
/// `rust/vendor/openab/agy-acp/src/types.rs`). We also accept the legacy
/// npm-adapter's `conversationId` key for backward compat, but the openab key
/// is authoritative.
pub fn conversation_id_for_acp_session(acp_session_id: &str) -> Option<String> {
    let store = read_sessions_store()?;
    let sessions = store.get("sessions")?;
    let entry = sessions.get(acp_session_id)?;
    for key in ["conversation_id", "conversationId"] {
        if let Some(serde_json::Value::String(s)) = entry.get(key) {
            if !s.is_empty() {
                return Some(s.clone());
            }
        }
    }
    None
}

/// A tiny `which`-equivalent over PATH (std-only).
fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(name);
        if cand.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&cand) {
                    if meta.permissions().mode() & 0o111 != 0 {
                        return Some(cand);
                    }
                }
            }
            #[cfg(not(unix))]
            return Some(cand);
        }
    }
    None
}
