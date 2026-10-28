//! `ScopeResolver`: how the owner learns about worktrees, projects, sessions and
//! the data home without depending on `vst-git`/`vst-agents` (built in `run.rs`
//! or, for the store-backed default, [`StoreResolver`]).

use std::path::PathBuf;

use async_trait::async_trait;
use vst_store::StoreHandle;
use vst_types::artifacts::ScopeKey;

/// Where a session writes and whether it can still add artifacts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionScope {
    pub scope: ScopeKey,
    pub cwd: PathBuf,
    pub archived: bool,
}

#[async_trait]
pub trait ScopeResolver: Send + Sync + 'static {
    /// Root directory of a scope; `None` = unknown scope (effects are dropped).
    async fn scope_root(&self, scope: &ScopeKey) -> Option<PathBuf>;
    /// Scope + cwd of a session id (the spawn token); `None` = unknown session.
    async fn session_scope(&self, session_id: &str) -> Option<SessionScope>;
    /// Every registered project and worktree root (denylist exceptions).
    async fn registered_roots(&self) -> Vec<PathBuf>;
    async fn scope_exists(&self, scope: &ScopeKey) -> bool;
    /// `~/.vibe-station` (from `Paths`, never a cached `$HOME`).
    fn vst_home(&self) -> PathBuf;
}

/// Resolver over the project store; the data home is injected (`Paths`).
pub struct StoreResolver {
    store: StoreHandle,
    vst_home: PathBuf,
}

impl StoreResolver {
    pub fn new(store: StoreHandle, vst_home: PathBuf) -> Self {
        Self { store, vst_home }
    }

    fn worktree_path(&self, project_id: &str, worktree_id: &str) -> PathBuf {
        self.vst_home
            .join("projects")
            .join(project_id)
            .join("worktrees")
            .join(worktree_id)
    }
}

#[async_trait]
impl ScopeResolver for StoreResolver {
    async fn scope_root(&self, scope: &ScopeKey) -> Option<PathBuf> {
        use vst_types::artifacts::ScopeKind;
        match scope.scope_kind {
            ScopeKind::Project => self
                .store
                .get_project(&scope.scope_id)
                .await
                .map(|p| PathBuf::from(p.absolute_path)),
            ScopeKind::Worktree => self
                .store
                .get_all_projects()
                .await
                .into_iter()
                .find(|p| p.worktrees.iter().any(|w| w.id == scope.scope_id))
                .map(|p| self.worktree_path(&p.id, &scope.scope_id)),
        }
    }

    async fn session_scope(&self, session_id: &str) -> Option<SessionScope> {
        let (project, session) = self.store.find_session(session_id).await?;
        let archived = session.archived_at.is_some();
        Some(match session.worktree_id {
            Some(wid) => SessionScope {
                cwd: self.worktree_path(&project.id, &wid),
                scope: ScopeKey::worktree(wid),
                archived,
            },
            None => SessionScope {
                cwd: PathBuf::from(&project.absolute_path),
                scope: ScopeKey::project(project.id),
                archived,
            },
        })
    }

    async fn registered_roots(&self) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        for p in self.store.get_all_projects().await {
            for w in &p.worktrees {
                roots.push(self.worktree_path(&p.id, &w.id));
            }
            roots.push(PathBuf::from(p.absolute_path));
        }
        roots
    }

    async fn scope_exists(&self, scope: &ScopeKey) -> bool {
        self.scope_root(scope).await.is_some()
    }

    fn vst_home(&self) -> PathBuf {
        self.vst_home.clone()
    }
}
