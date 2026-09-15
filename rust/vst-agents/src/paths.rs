//! `~/.vibe-station` path derivation (ports the subset of `paths.ts` /
//! `context.ts` that this crate needs for opencode's config path and agy's
//! log path). Mirrors the `Paths` pattern established by `vst-git` so tests
//! can point it at a temp data-home.
//!
//! ## OWNERSHIP NOTE (read before editing)
//!
//! The TS sources for the path helpers here (`daemon/src/services/paths.ts`,
//! `daemon/src/services/context.ts`'s `*For(ctx, …)` helpers) are assigned to
//! parts **00 / 04c** in `file-map.tsv`, **not** 04a. They are implemented here
//! only because 04a's `opencode` plugin's `get_environment` (and the 04a tests
//! exercising it) need the session-data / opencode-config path derivation.
//! **When 04c (or a shared-paths factoring) runs: read this file first and
//! adopt/extend it rather than re-deriving from the TS source — do not create
//! a second, conflicting implementation.** This mirrors the `Paths` struct
//! precedent already established by `vst-git::paths` for the same reason.

use std::path::{Path, PathBuf};

use crate::home::home_dir;

/// `~/.vibe-station` path provider. Holds the data-home root so tests can
/// point it at a temp directory instead of the real home.
#[derive(Clone, Debug)]
pub struct Paths {
    vst_home: PathBuf,
}

impl Default for Paths {
    fn default() -> Self {
        Self {
            vst_home: home_dir().join(".vibe-station"),
        }
    }
}

impl Paths {
    /// A provider rooted at an arbitrary data-home (test seam).
    pub fn with_home(vst_home: PathBuf) -> Self {
        Self { vst_home }
    }

    /// `~/.vibe-station`
    pub fn vst_home(&self) -> &Path {
        &self.vst_home
    }

    /// `~/.vibe-station/projects/<id>`
    pub fn project_dir(&self, project_id: &str) -> PathBuf {
        self.vst_home.join("projects").join(project_id)
    }

    /// `~/.vibe-station/projects/<p>/session-data/<w>/<s>`
    pub fn session_data_dir(
        &self,
        project_id: &str,
        worktree_id: &str,
        session_id: &str,
    ) -> PathBuf {
        self.project_dir(project_id)
            .join("session-data")
            .join(worktree_id)
            .join(session_id)
    }

    /// `~/.vibe-station/projects/<p>/sessions/<s>` (direct sessions, no worktree)
    pub fn direct_session_data_dir(&self, project_id: &str, session_id: &str) -> PathBuf {
        self.project_dir(project_id)
            .join("sessions")
            .join(session_id)
    }

    /// `<sessionDataDir>/system-prompt.md` for a worktree context.
    pub fn system_prompt_path(
        &self,
        project_id: &str,
        worktree_id: &str,
        session_id: &str,
    ) -> PathBuf {
        self.session_data_dir(project_id, worktree_id, session_id)
            .join("system-prompt.md")
    }

    /// `<directSessionDataDir>/system-prompt.md` for a direct context.
    pub fn direct_system_prompt_path(&self, project_id: &str, session_id: &str) -> PathBuf {
        self.direct_session_data_dir(project_id, session_id)
            .join("system-prompt.md")
    }

    /// `<sessionDataDir>/opencode-config.json` for a worktree context.
    pub fn opencode_config_path(
        &self,
        project_id: &str,
        worktree_id: &str,
        session_id: &str,
    ) -> PathBuf {
        self.session_data_dir(project_id, worktree_id, session_id)
            .join("opencode-config.json")
    }

    /// `<directSessionDataDir>/opencode-config.json` for a direct context.
    pub fn direct_opencode_config_path(&self, project_id: &str, session_id: &str) -> PathBuf {
        self.direct_session_data_dir(project_id, session_id)
            .join("opencode-config.json")
    }
}
