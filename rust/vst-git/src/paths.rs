//! `~/.vibe-station` path derivation (ports the subset of `paths.ts` that this
//! crate needs).
//!
//! The full `paths.ts` module is part-00 scope and has not yet been ported into
//! a shared crate; the path helpers used by `recover`, `rollback`,
//! `worktree_service` and `session_id` are defined here so `vst-git` does not
//! reach outside its own crate. Future parts that need the rest of `paths.ts`
//! should factor it into a shared home rather than duplicating it.

use std::path::PathBuf;

/// `~/.vibe-station` path provider. Holds the data-home root so tests can point
/// it at a temp directory instead of the real home.
#[derive(Clone, Debug)]
pub struct Paths {
    vst_home: PathBuf,
}

impl Default for Paths {
    fn default() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        Self {
            vst_home: PathBuf::from(home).join(".vibe-station"),
        }
    }
}

impl Paths {
    /// The real `~/.vibe-station` (from `$HOME`).
    pub fn default_home() -> Self {
        Self::default()
    }

    /// A provider rooted at an arbitrary data-home (test seam).
    pub fn with_home(vst_home: PathBuf) -> Self {
        Self { vst_home }
    }

    /// `~/.vibe-station`
    pub fn vst_home(&self) -> &PathBuf {
        &self.vst_home
    }

    /// `~/.vibe-station/projects/<id>`
    pub fn project_dir(&self, project_id: &str) -> PathBuf {
        self.vst_home.join("projects").join(project_id)
    }

    /// `~/.vibe-station/projects/<id>/worktrees/<worktreeId>`
    pub fn worktree_path(&self, project_id: &str, worktree_id: &str) -> PathBuf {
        self.project_dir(project_id)
            .join("worktrees")
            .join(worktree_id)
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
}
