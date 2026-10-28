#![allow(dead_code)]
//! Shared harness: real sqlite store, a project with one worktree, a real
//! `ArtifactsHandle` over a fixed resolver, and a broadcaster receiver.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use tempfile::TempDir;
use tokio::sync::broadcast;
use vst_artifacts::{ArtifactsHandle, PathKeyer, ScopeResolver, SessionScope};
use vst_review::ReviewHandle;
use vst_store::artifacts::ArtifactWrite;
use vst_store::StoreHandle;
use vst_types::artifacts::{AddedVia, ScopeKey};
use vst_types::rest::review::CreateCommentBody;
use vst_types::review::{CommentSurface, PathKind, ReviewComment};
use vst_types::{
    Broadcaster, LifecycleState, ProjectRecord, ServerEvent, SessionRecord, SessionType,
    WorktreeRecord,
};

pub const T0: &str = "2026-01-01T00:00:00.000Z";

pub struct Resolver {
    pub roots: Vec<ScopeKey>,
    pub home: PathBuf,
}

#[async_trait]
impl ScopeResolver for Resolver {
    async fn scope_root(&self, scope: &ScopeKey) -> Option<PathBuf> {
        self.roots.contains(scope).then(|| self.home.clone())
    }
    async fn session_scope(&self, _: &str) -> Option<SessionScope> {
        None
    }
    async fn registered_roots(&self) -> Vec<PathBuf> {
        Vec::new()
    }
    async fn scope_exists(&self, scope: &ScopeKey) -> bool {
        self.roots.contains(scope)
    }
    fn vst_home(&self) -> PathBuf {
        self.home.clone()
    }
}

fn session(id: &str, project_id: &str, worktree_id: Option<&str>) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: worktree_id.map(Into::into),
        project_id: project_id.into(),
        is_main: worktree_id.is_some(),
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: Some("m".into()),
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: format!("{id}-pane"),
        use_tmux: true,
        channel: None,
        lifecycle: vst_types::SessionLifecycle {
            state: LifecycleState::Idle,
            reason: None,
            last_transition_at: T0.into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        archived_at: None,
        handoff_summary: None,
        carry_over: None,
        draft_prompt: None,
        draft_config: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        last_activity_at: None,
        last_line: None,
        last_tool: None,
    }
}

pub fn project(id: &str, worktree_id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        absolute_path: format!("/fake/{id}-folder"),
        prefix: "prj".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: T0.into(),
        hidden: None,
        direct_sessions: vec![session("direct-1", id, None)],
        direct_session_seq: None,
        worktrees: vec![WorktreeRecord {
            id: worktree_id.into(),
            name: None,
            branch: "feature/review".into(),
            branch_is_placeholder: None,
            base_branch: "main".into(),
            base_sha: "a".repeat(40),
            created_at: T0.into(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 0.0,
            terminal_seq: Some(0),
            agent_seq: Some(0),
            lsp_enabled: None,
            sessions: vec![session("sess-1", id, Some(worktree_id))],
            open_files: vec![],
        }],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    }
}

pub struct Env {
    pub _dir: TempDir,
    pub base: PathBuf,
    pub store: StoreHandle,
    pub broadcaster: Broadcaster,
    pub artifacts: ArtifactsHandle,
    pub review: ReviewHandle,
    pub clock: Arc<AtomicU64>,
    pub rx: broadcast::Receiver<ServerEvent>,
    pub wt: ScopeKey,
    pub proj: ScopeKey,
}

impl Env {
    pub async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let store = StoreHandle::open(base.join("vst.db")).unwrap();
        store.add_project(project("p1", "wt-1")).await.unwrap();
        let broadcaster = Broadcaster::new(256);
        let rx = broadcaster.subscribe();
        let wt = ScopeKey::worktree("wt-1");
        let proj = ScopeKey::project("p1");
        let artifacts = ArtifactsHandle::new(
            store.clone(),
            broadcaster.clone(),
            Arc::new(Resolver {
                roots: vec![wt.clone(), proj.clone()],
                home: base.join("home"),
            }),
        );
        let clock = Arc::new(AtomicU64::new(1_767_225_600)); // 2026-01-01T00:00:00Z
        let c = clock.clone();
        let review = ReviewHandle::new(store.clone(), broadcaster.clone(), artifacts.clone())
            .with_clock(Arc::new(move || c.load(Ordering::SeqCst)));
        Env {
            _dir: dir,
            base,
            store,
            broadcaster,
            artifacts,
            review,
            clock,
            rx,
            wt,
            proj,
        }
    }

    /// Register `path` (an existing absolute file) as an artifact of `scope`.
    pub async fn register_artifact(&self, scope: &ScopeKey, path: &Path) {
        let key = PathKeyer::default().key_for(path);
        self.store
            .upsert_artifact(ArtifactWrite {
                id: format!("art-{}", path.display()),
                scope: scope.clone(),
                path: path.to_string_lossy().into_owned(),
                path_key: key,
                in_repo: false,
                hash: Some("h".into()),
                size: Some(1),
                mtime_ms: Some(1),
                writer: Some("sess-1".into()),
                added_via: AddedVia::Cli,
                now: T0.into(),
            })
            .await
            .unwrap();
    }

    /// The directory both scopes resolve to (the fixed resolver's root).
    pub fn root(&self) -> PathBuf {
        let root = self.base.join("home");
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// A review owner with the bounded watcher attached; `roots` are the scopes
    /// the resolver knows (all resolve to [`Env::root`]).
    pub fn review_with(
        &self,
        watcher: vst_fswatch::path_watcher::PathWatcher,
        roots: Vec<ScopeKey>,
    ) -> ReviewHandle {
        let c = self.clock.clone();
        ReviewHandle::new(
            self.store.clone(),
            self.broadcaster.clone(),
            self.artifacts.clone(),
        )
        .with_clock(Arc::new(move || c.load(Ordering::SeqCst)))
        .with_watcher(
            watcher,
            Arc::new(Resolver {
                roots,
                home: self.root(),
            }),
        )
    }

    pub fn advance(&self, secs: u64) {
        self.clock.fetch_add(secs, Ordering::SeqCst);
    }

    /// Drain every `comments:changed` currently queued (after `flush_events`).
    pub fn events(&mut self) -> Vec<Changed> {
        let mut out = Vec::new();
        while let Ok(ev) = self.rx.try_recv() {
            if let ServerEvent::CommentsChanged {
                upserted, deleted, ..
            } = ev
            {
                out.push((
                    upserted,
                    deleted
                        .into_iter()
                        .map(|d| (d.id, d.reason.as_str().to_string()))
                        .collect(),
                ));
            }
        }
        out
    }
}

/// One drained `comments:changed`: upserted comments and `(id, reason)` removals.
pub type Changed = (Vec<ReviewComment>, Vec<(String, String)>);

pub fn body(id: &str, path: &str, line: u32) -> CreateCommentBody {
    CreateCommentBody {
        id: id.into(),
        path: path.into(),
        path_kind: PathKind::Repo,
        surface: CommentSurface::File,
        diff_scope: None,
        base_sha: None,
        side: None,
        line_start: Some(line),
        line_end: Some(line),
        old_start: None,
        old_end: None,
        new_start: None,
        new_end: None,
        quote: format!("quote of {id}"),
        prefix: "before ".into(),
        suffix: " after".into(),
        occurrence: 0,
        text: format!("text of {id}"),
        restore_pin: None,
    }
}
