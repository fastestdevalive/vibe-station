#![allow(dead_code)]
//! Shared harness: real tempdir file system + real sqlite store + fixed resolver.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tempfile::TempDir;
use tokio::sync::broadcast;
use vst_artifacts::{ArtifactsHandle, ScopeResolver, SessionScope};
use vst_store::StoreHandle;
use vst_types::artifacts::{ArtifactSink, FileEffect, ScopeKey, WriteContext};
use vst_types::{Broadcaster, ServerEvent};

pub struct FixedResolver {
    pub roots: HashMap<ScopeKey, PathBuf>,
    pub sessions: HashMap<String, SessionScope>,
    pub registered: Vec<PathBuf>,
    pub vst_home: PathBuf,
}

#[async_trait]
impl ScopeResolver for FixedResolver {
    async fn scope_root(&self, scope: &ScopeKey) -> Option<PathBuf> {
        self.roots.get(scope).cloned()
    }
    async fn session_scope(&self, id: &str) -> Option<SessionScope> {
        self.sessions.get(id).cloned()
    }
    async fn registered_roots(&self) -> Vec<PathBuf> {
        self.registered.clone()
    }
    async fn scope_exists(&self, scope: &ScopeKey) -> bool {
        self.roots.contains_key(scope)
    }
    fn vst_home(&self) -> PathBuf {
        self.vst_home.clone()
    }
}

pub struct Env {
    pub dir: TempDir,
    pub base: PathBuf,
    pub root: PathBuf,
    pub outside: PathBuf,
    pub vst_home: PathBuf,
    pub scope: ScopeKey,
    pub store: StoreHandle,
    pub handle: ArtifactsHandle,
    pub rx: broadcast::Receiver<ServerEvent>,
    pub db_path: PathBuf,
}

impl Env {
    pub async fn new() -> Self {
        Self::with_sessions(&["sess-a"]).await
    }

    pub async fn with_sessions(sessions: &[&str]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let root = base.join("repo");
        let outside = base.join("outside");
        let home = base.join("home");
        let vst_home = home.join(".vibe-station");
        for d in [&root, &outside, &vst_home, &base.join("db")] {
            std::fs::create_dir_all(d).unwrap();
        }
        let db_path = base.join("db").join("store.sqlite");
        let store = StoreHandle::open(&db_path).unwrap();
        let scope = ScopeKey::worktree("wt-1");
        let mut roots = HashMap::new();
        roots.insert(scope.clone(), root.clone());
        let mut sess = HashMap::new();
        for s in sessions {
            sess.insert(
                (*s).to_string(),
                SessionScope {
                    scope: scope.clone(),
                    cwd: root.clone(),
                    archived: false,
                },
            );
        }
        sess.insert(
            "sess-archived".into(),
            SessionScope {
                scope: scope.clone(),
                cwd: root.clone(),
                archived: true,
            },
        );
        let resolver = Arc::new(FixedResolver {
            roots,
            sessions: sess,
            registered: vec![],
            vst_home: vst_home.clone(),
        });
        let broadcaster = Broadcaster::new(4096);
        let rx = broadcaster.subscribe();
        let handle = ArtifactsHandle::new(store.clone(), broadcaster, resolver);
        Self {
            dir,
            base,
            root,
            outside,
            vst_home,
            scope,
            store,
            handle,
            rx,
            db_path,
        }
    }

    pub fn ctx(&self, session: &str) -> WriteContext {
        WriteContext {
            project_id: "prj-1".into(),
            worktree_id: Some("wt-1".into()),
            session_id: session.into(),
            cwd: self.root.clone(),
        }
    }

    pub fn file(&self, path: &Path, content: &str) -> PathBuf {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(path, content).unwrap();
        path.to_path_buf()
    }

    pub fn out(&self, name: &str) -> PathBuf {
        self.outside.join(name)
    }

    /// Queue a write effect (does not drain).
    pub fn record(&self, session: &str, path: &Path) {
        self.handle.record(
            self.ctx(session),
            vec![FileEffect::write(path.to_string_lossy())],
        );
    }

    /// Record and apply one write.
    pub async fn write_now(&self, session: &str, path: &Path) {
        self.record(session, path);
        self.handle.drain_now().await;
    }

    pub fn events(&mut self) -> Vec<ServerEvent> {
        self.handle.flush_events();
        let mut out = Vec::new();
        while let Ok(e) = self.rx.try_recv() {
            out.push(e);
        }
        out
    }
}
