use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, watch, Mutex, RwLock};
use tracing::{debug, info, warn};
use vst_types::rest::lsp::{
    LspDegraded, LspDegradedLevel, LspFailure, LspFailureKind, LspFileRef, LspStatus,
};
use vst_ws::streams::file_watcher::{FileWatcher, WatcherCallbacks, WatcherHandle};

use crate::client::{
    LspClient, LspClientError, ProgressKind, ProgressNotification, ServerHealth, ServerLogMessage,
    ServerStatusNotification,
};
use crate::deps::{self, DependencyModel, DependencyProbe, ProbeCtx};
use crate::failure::{self, ServerLog, MESSAGE_CAP};
use crate::registry::{self, LanguageServerConfig};
use crate::uri::{path_to_uri, uri_to_path};

pub fn is_sensitive_path(path: &Path, vst_home: Option<&Path>) -> bool {
    let mut prefixes: Vec<PathBuf> = vec![PathBuf::from("/etc"), PathBuf::from("/root")];

    let home = std::env::var("HOME").ok().map(PathBuf::from);
    if let Some(h) = &home {
        prefixes.push(h.join(".ssh"));
        prefixes.push(h.join(".aws"));
        prefixes.push(h.join(".vibe-station"));
    }

    if let Some(vh) = vst_home {
        prefixes.push(vh.to_path_buf());
    }

    for prefix in prefixes {
        if path.starts_with(&prefix) {
            return true;
        }
        if let Ok(canon_prefix) = prefix.canonicalize() {
            if path.starts_with(&canon_prefix) {
                return true;
            }
        }
    }

    false
}

/// Resolves a `LspFileRef::Workspace` relative path against the worktree root,
/// enforcing path confinement so a request can never escape the worktree:
///
/// - An absolute path is rejected outright (an external file is reached via
///   `LspFileRef::External { token }`, never via a fake workspace path).
/// - The joined path is canonicalized, `root` is canonicalized the same way,
///   and the result must live under the canonicalized root — a `..`-escaping
///   relative path is rejected.
///
/// Deliberately does NOT call `is_sensitive_path` — that check exists for
/// paths reached OUTSIDE a workspace root (external-file serving, the
/// definition/references "is_internal" split), where `$VST_HOME` genuinely
/// needs blocking. A real worktree/project directory lives INSIDE
/// `$VST_HOME` (`~/.vibe-station/projects/<p>/worktrees/<w>/...`), so
/// applying that same check here would reject every legitimate in-workspace
/// file — root-confinement alone is the correct and sufficient guarantee for
/// this function: `root` is a directory the daemon already trusts, and
/// confinement to it excludes every sibling project/worktree/system path.
///
/// Returns `LspError::NotFound` when the path is rejected or doesn't resolve to
/// a file under the root.
pub fn resolve_workspace_path(root: &Path, rel_path: &str) -> Result<PathBuf, LspError> {
    let p = Path::new(rel_path);
    if p.is_absolute() {
        return Err(LspError::NotFound);
    }

    let joined = root.join(p);
    let canon_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let canon = joined.canonicalize().unwrap_or_else(|_| joined.clone());

    if !canon.starts_with(&canon_root) {
        return Err(LspError::NotFound);
    }

    Ok(canon)
}

struct ExternalTokenMap {
    tokens: HashMap<String, PathBuf>,
    paths: HashMap<PathBuf, String>,
    order: VecDeque<String>,
}

impl ExternalTokenMap {
    fn new() -> Self {
        Self {
            tokens: HashMap::new(),
            paths: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn get_or_mint(&mut self, canonical_path: &Path) -> String {
        if let Some(existing) = self.paths.get(canonical_path) {
            return existing.clone();
        }

        let token = uuid::Uuid::new_v4().to_string();

        if self.tokens.len() >= 200 {
            while let Some(oldest) = self.order.pop_front() {
                if let Some(removed_path) = self.tokens.remove(&oldest) {
                    self.paths.remove(&removed_path);
                    break;
                }
            }
        }

        self.tokens
            .insert(token.clone(), canonical_path.to_path_buf());
        self.paths
            .insert(canonical_path.to_path_buf(), token.clone());
        self.order.push_back(token.clone());

        token
    }

    fn resolve(&self, token: &str) -> Option<PathBuf> {
        self.tokens.get(token).cloned()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LspError {
    #[error("Language server not found")]
    NotFound,
    #[error("Language server still starting")]
    Starting,
    #[error("Language server timed out")]
    Timeout,
    #[error("Language server process died")]
    ProcessDied,
    #[error("LSP operation unsupported")]
    Unsupported,
    #[error("Unknown external token")]
    UnknownExternalToken,
    #[error("Code navigation is disabled for this workspace")]
    Disabled,
    #[error("Language server error: {0}")]
    ServerError(String),
    /// The server failed to come up and the failure is latched: no respawn
    /// until Retry, a successful dependency re-probe, or crash backoff.
    #[error("{}", .0.summary)]
    Failed(Box<LspFailure>),
}

impl From<LspClientError> for LspError {
    fn from(e: LspClientError) -> Self {
        match e {
            LspClientError::Timeout => LspError::Timeout,
            LspClientError::ChannelClosed => LspError::ProcessDied,
            LspClientError::RpcError { message, .. } => LspError::ServerError(message),
            other => LspError::ServerError(other.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum WorkspaceKey {
    Worktree {
        project_id: String,
        worktree_id: String,
    },
    Project {
        project_id: String,
    },
}

impl WorkspaceKey {
    pub fn to_key_string(&self) -> String {
        match self {
            Self::Worktree {
                project_id,
                worktree_id,
            } => format!("{}-{}", project_id, worktree_id),
            Self::Project { project_id } => project_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LspRequestKind {
    Definition,
    Hover,
    References,
    Outline,
}

#[derive(Debug, Clone)]
pub struct LocationTarget {
    pub abs_path: PathBuf,
    pub line: u32,
    pub character: u32,
    /// Exclusive UTF-16 end column; `None` when the range spans lines.
    pub end_character: Option<u32>,
    /// The raw (untrimmed) source line `character` indexes into.
    pub preview: String,
}

#[derive(Debug, Clone)]
pub struct ReferenceTarget {
    pub abs_path: PathBuf,
    pub line: u32,
    pub character: u32,
    /// Exclusive UTF-16 end column; `None` when the range spans lines.
    pub end_character: Option<u32>,
    /// The raw (untrimmed) source line `character` indexes into.
    pub preview: String,
    pub is_declaration: bool,
}

#[derive(Debug, Clone)]
pub enum LspResponse {
    Definition(Vec<LocationTarget>),
    Hover(Value),
    References(Vec<ReferenceTarget>),
    Outline(Value),
}

#[derive(Clone)]
pub struct ServerHandle {
    pub client: Arc<LspClient>,
    pub child: Arc<Mutex<Option<tokio::process::Child>>>,
    pub status: Arc<RwLock<LspStatus>>,
    pub last_request: Arc<RwLock<Instant>>,
    pub open_files: Arc<Mutex<HashSet<PathBuf>>>,
    pub file_versions: Arc<Mutex<HashMap<PathBuf, i64>>>,
    pub language: String,
    /// Latches to `true` once the `initialize` handshake has completed (the
    /// `initialize` response was received AND the `initialized` notification
    /// was sent). `request()` awaits this before sending `didOpen` or any
    /// request, because LSP-conformant servers (rust-analyzer 1.98.1 etc.)
    /// reject/crash on traffic sent before `initialized`.
    pub initialized: watch::Receiver<bool>,
    /// Last health warning/error message from `experimental/serverStatus`
    /// (`None` while healthy, or for servers that never send it). The server
    /// keeps answering while degraded, so this does NOT change `status`.
    pub health: Arc<RwLock<Option<String>>>,
}

/// How long the progress-token fallback waits after the last `end` before
/// declaring `Ready`. rust-analyzer-style servers run phases back to back
/// (Fetching → end → Building CrateGraph → … → Indexing); without this, the
/// status flipped to `Ready` in each gap and requests landing there ran
/// against a half-loaded server and came back empty.
const READY_DEBOUNCE: Duration = Duration::from_secs(1);

/// What the status loop should do after a readiness signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Readiness {
    /// Nothing changes.
    Unchanged,
    /// Background work started: `Indexing`, and cancel any pending `Ready`.
    Indexing,
    /// Progress-token fallback went idle: `Ready` after `READY_DEBOUNCE`
    /// unless more work begins first.
    ReadySoon,
    /// The server itself says it's quiescent: `Ready` now.
    ReadyNow,
}

/// Readiness state machine, kept free of I/O and timers so it can be unit
/// tested. Once a server has sent `experimental/serverStatus` its `quiescent`
/// flag is authoritative and `$/progress` is ignored for readiness (it still
/// carries e.g. `cargo check` runs, which don't block navigation); servers
/// that never send it (tsserver, pyright, …) use the progress-token path.
#[derive(Debug, Default)]
struct ReadinessTracker {
    active_tokens: HashSet<String>,
    server_status_seen: bool,
}

impl ReadinessTracker {
    fn on_progress(&mut self, kind: &ProgressKind, token: &Value) -> Readiness {
        let token = token.to_string();
        match kind {
            ProgressKind::Begin => {
                self.active_tokens.insert(token);
                if self.server_status_seen {
                    Readiness::Unchanged
                } else {
                    Readiness::Indexing
                }
            }
            ProgressKind::Report => Readiness::Unchanged,
            ProgressKind::End => {
                self.active_tokens.remove(&token);
                if !self.server_status_seen && self.active_tokens.is_empty() {
                    Readiness::ReadySoon
                } else {
                    Readiness::Unchanged
                }
            }
        }
    }

    fn on_server_status(&mut self, status: &ServerStatusNotification) -> Readiness {
        self.server_status_seen = true;
        if status.quiescent {
            Readiness::ReadyNow
        } else {
            Readiness::Indexing
        }
    }
}

/// The message to surface as `degraded` for a server status, or `None` when healthy.
fn health_message(status: &ServerStatusNotification) -> Option<String> {
    let fallback = match status.health {
        ServerHealth::Ok => return None,
        ServerHealth::Warning => "Language server reported a warning",
        ServerHealth::Error => "Language server reported an error",
    };
    Some(
        status
            .message
            .clone()
            .unwrap_or_else(|| fallback.to_string()),
    )
}

/// Applies a `Readiness` transition to the shared status. `Error`/`Stopped`
/// are terminal for this loop and never overwritten.
async fn apply_readiness(status: &RwLock<LspStatus>, target: LspStatus) {
    let mut s = status.write().await;
    if matches!(*s, LspStatus::Error | LspStatus::Stopped) {
        return;
    }
    // A quiescent/idle signal must not undo the sweeper's `Idle` marking.
    if target == LspStatus::Ready && *s == LspStatus::Idle {
        return;
    }
    *s = target;
}

type ServerKey = (WorkspaceKey, String);
type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;
type ServerMap = Arc<Mutex<HashMap<ServerKey, ServerHandle>>>;
type FailureMap = Arc<Mutex<HashMap<ServerKey, FailureRecord>>>;

/// A latched start failure. Lives in `LspManager::failures`, NOT on the
/// handle, because `ensure_server_handle` removes and replaces handles.
#[derive(Debug, Clone)]
struct FailureRecord {
    failure: LspFailure,
    at: Instant,
    /// Last dependency re-probe (throttles `status()` polling).
    last_probe: Instant,
    /// Workspace root, so `status()` / watcher events can re-probe + respawn.
    root: PathBuf,
    /// True when the structural probe produced this failure, so a later
    /// probe flipping to `Ok` means "fixed" (re-probe + auto-respawn). A
    /// hint-upgraded init error (probe said Ok, server disagreed) is false:
    /// re-probing would just respawn into the same failure every 10 s.
    reprobe: bool,
}

/// Crashes (after a successful initialize) within the current window.
#[derive(Debug, Clone, Copy)]
struct CrashHistory {
    count: u32,
    first_at: Instant,
}

const CRASH_WINDOW: Duration = Duration::from_secs(120);

/// Whether a `Missing` probe result may still be overridden by a real spawn
/// attempt (our probe can miss a TypeScript the server would have found).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeGuard {
    /// The one real attempt was used (and, unless later disproved, failed).
    Spent,
    /// A real attempt succeeded despite `Missing`: never short-circuit again.
    Disproved,
}

#[derive(Debug, Clone)]
struct Timing {
    reprobe_interval: Duration,
    crash_backoff: Vec<Duration>,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            reprobe_interval: Duration::from_secs(10),
            crash_backoff: vec![
                Duration::from_secs(2),
                Duration::from_secs(10),
                Duration::from_secs(30),
            ],
        }
    }
}

/// Dependency manifests whose change re-probes a latched dependency failure.
/// (`node_modules/` itself is ignored by the file watcher, so a plain
/// `npm install` is caught by the throttled `status()` re-probe instead.)
const DEPENDENCY_MANIFESTS: &[&str] = &[
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
];

/// How a server is about to be launched, as decided by the dependency probe.
struct LaunchPlan {
    init_options: Option<Value>,
    note: Option<String>,
    /// Set when the probe said `Missing` but the one guarded real attempt is
    /// being made: if `initialize` fails, this classification is confirmed.
    pending_dependency: Option<LspFailure>,
}

enum SpawnError {
    NotFound,
    Other(String),
}

pub struct LspManager {
    me: Weak<LspManager>,
    vst_home: PathBuf,
    servers: ServerMap,
    watchers: Arc<Mutex<HashMap<WorkspaceKey, Arc<FileWatcher>>>>,
    external_tokens: Arc<Mutex<HashMap<WorkspaceKey, ExternalTokenMap>>>,
    ever_ready: Mutex<HashSet<(WorkspaceKey, String)>>,
    failures: FailureMap,
    crash_history: Arc<Mutex<HashMap<ServerKey, CrashHistory>>>,
    probe_guard: Arc<Mutex<HashMap<ServerKey, ProbeGuard>>>,
    /// Info-level note from the dependency probe for the live server
    /// (e.g. "Using TypeScript 5.9.3 (global) — …").
    notes: Mutex<HashMap<ServerKey, String>>,
    npm_root: tokio::sync::OnceCell<Option<PathBuf>>,
    npm_root_override: std::sync::Mutex<Option<Option<PathBuf>>>,
    timing: std::sync::Mutex<Timing>,
}

impl LspManager {
    pub fn new(vst_home: PathBuf) -> Arc<Self> {
        let mgr = Arc::new_cyclic(|me| Self {
            me: me.clone(),
            vst_home,
            servers: Arc::new(Mutex::new(HashMap::new())),
            watchers: Arc::new(Mutex::new(HashMap::new())),
            external_tokens: Arc::new(Mutex::new(HashMap::new())),
            ever_ready: Mutex::new(HashSet::new()),
            failures: Arc::new(Mutex::new(HashMap::new())),
            crash_history: Arc::new(Mutex::new(HashMap::new())),
            probe_guard: Arc::new(Mutex::new(HashMap::new())),
            notes: Mutex::new(HashMap::new()),
            npm_root: tokio::sync::OnceCell::new(),
            npm_root_override: std::sync::Mutex::new(None),
            timing: std::sync::Mutex::new(Timing::default()),
        });

        // `npm root -g` once per daemon lifetime, off the request path.
        let weak = Arc::downgrade(&mgr);
        tokio::spawn(async move {
            if let Some(m) = weak.upgrade() {
                let _ = m.npm_global_root().await;
            }
        });

        // Spawn idle / stopped sweep task (Decision 3)
        let servers_clone = mgr.servers.clone();
        let watchers_clone = mgr.watchers.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            loop {
                interval.tick().await;
                let mut servers_guard = servers_clone.lock().await;
                let mut stopped_workspaces = HashSet::new();

                for ((ws, _lang), handle) in servers_guard.iter_mut() {
                    let elapsed = handle.last_request.read().await.elapsed();
                    if elapsed >= Duration::from_secs(600) {
                        // 10 minutes: hard-stop (kill process)
                        let mut status = handle.status.write().await;
                        if *status != LspStatus::Stopped {
                            info!("Stopping language server for workspace {:?} (10m idle)", ws);
                            *status = LspStatus::Stopped;
                            let mut child_guard = handle.child.lock().await;
                            if let Some(mut child) = child_guard.take() {
                                let _ = child.kill().await;
                            }
                            stopped_workspaces.insert(ws.clone());
                        }
                    } else if elapsed >= Duration::from_secs(300) {
                        // 5 minutes: mark idle
                        let mut status = handle.status.write().await;
                        if *status == LspStatus::Ready {
                            debug!("Marking language server idle for workspace {:?}", ws);
                            *status = LspStatus::Idle;
                        }
                    }
                }

                // Clean up watchers for stopped workspaces
                if !stopped_workspaces.is_empty() {
                    let mut watchers_guard = watchers_clone.lock().await;
                    for ws in stopped_workspaces {
                        let mut all_stopped = true;
                        for ((k, _), h) in servers_guard.iter() {
                            if k == &ws && *h.status.read().await != LspStatus::Stopped {
                                all_stopped = false;
                                break;
                            }
                        }
                        if all_stopped {
                            if let Some(watcher) = watchers_guard.remove(&ws) {
                                watcher.close();
                            }
                        }
                    }
                }
            }
        });

        mgr
    }

    /// Query the LSP status for a given workspace and file path (or extension).
    pub async fn status(
        &self,
        workspace: &WorkspaceKey,
        path: &str,
        enabled: bool,
    ) -> (LspStatus, Option<String>) {
        let (status, lang, _) = self.status_with_failure(workspace, path, enabled).await;
        (status, lang)
    }

    /// Like [`LspManager::status`], plus the latched failure decided in the
    /// same step — `failure.is_some()` ⇒ `status == Error`.
    ///
    /// While a dependency failure is latched this re-probes (throttled to
    /// `reprobe_interval`); when the probe flips to `Ok` the latch is cleared
    /// and the server respawned, so the caller sees `Starting`.
    pub async fn status_with_failure(
        &self,
        workspace: &WorkspaceKey,
        path: &str,
        enabled: bool,
    ) -> (LspStatus, Option<String>, Option<LspFailure>) {
        let ext = Path::new(path)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or(path);

        let Some(cfg) = registry::lookup(ext) else {
            return if !enabled {
                (LspStatus::Disabled, None, None)
            } else {
                (LspStatus::Unsupported, None, None)
            };
        };

        let lang = cfg.language.to_string();

        if !enabled {
            return (LspStatus::Disabled, Some(lang), None);
        }

        let key = (workspace.clone(), lang.clone());
        if let Some(root) = self.reprobe(&key, cfg, false).await {
            let _ = self.ensure_server_handle(workspace, &root, &lang).await;
        }
        if let Some(rec) = self.failures.lock().await.get(&key) {
            return (LspStatus::Error, Some(lang), Some(rec.failure.clone()));
        }

        let servers = self.servers.lock().await;
        if let Some(handle) = servers.get(&key) {
            let status = *handle.status.read().await;
            return (status, Some(lang), None);
        }

        // Check if command is on PATH
        if !binary_on_path(cfg.command) {
            return (LspStatus::NotFound, Some(lang), None);
        }

        (LspStatus::Stopped, Some(lang), None)
    }

    /// The latched start failure for the language handling `path`, if any.
    pub async fn failure(&self, workspace: &WorkspaceKey, path: &str) -> Option<LspFailure> {
        let lang = lang_for_path(path)?;
        self.failures
            .lock()
            .await
            .get(&(workspace.clone(), lang))
            .map(|r| r.failure.clone())
    }

    /// Re-probes a latched, probe-produced dependency failure for `key`.
    /// Returns the workspace root when the probe now says `Ok` and the latch
    /// was cleared (the caller respawns). `force` skips the throttle
    /// (watcher events for dependency manifests).
    async fn reprobe(
        &self,
        key: &ServerKey,
        cfg: &'static LanguageServerConfig,
        force: bool,
    ) -> Option<PathBuf> {
        let dep = cfg.dependency?;
        let interval = self.timing.lock().unwrap().reprobe_interval;
        let root = {
            let mut failures = self.failures.lock().await;
            let rec = failures.get_mut(key)?;
            if !rec.reprobe || (!force && rec.last_probe.elapsed() < interval) {
                return None;
            }
            rec.last_probe = Instant::now();
            rec.root.clone()
        };
        let probe = self.run_probe(&dep, cfg, &root).await;
        let mut failures = self.failures.lock().await;
        let rec = failures.get_mut(key)?;
        let (kind, summary, install) = match probe {
            DependencyProbe::Ok { .. } => {
                info!("LSP dependency for {key:?} now resolves — clearing the latch, respawning");
                failures.remove(key);
                return Some(root);
            }
            DependencyProbe::Missing { summary, install } => {
                (LspFailureKind::MissingDependency, summary, install)
            }
            DependencyProbe::Incompatible {
                summary, install, ..
            } => (LspFailureKind::IncompatibleDependency, summary, install),
        };
        // The install command can change too (e.g. a lockfile appeared:
        // `npm i -D` -> `pnpm add -D`) — compare it, not just kind/summary.
        let next = failure::dependency_failure(kind, summary, install, rec.failure.message.clone());
        if rec.failure.kind != next.kind
            || rec.failure.summary != next.summary
            || rec.failure.remediation != next.remediation
        {
            rec.failure = next;
        }
        None
    }

    /// Re-probes every latched dependency failure in `workspace` now (a
    /// dependency manifest changed) and respawns the ones that resolve.
    // Boxed for the same reason as `auto_restart` (watcher → respawn cycle).
    fn reprobe_workspace<'a>(&'a self, workspace: &'a WorkspaceKey) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let keys: Vec<ServerKey> = self
                .failures
                .lock()
                .await
                .iter()
                .filter(|((ws, _), rec)| ws == workspace && rec.reprobe)
                .map(|(k, _)| k.clone())
                .collect();
            for key in keys {
                let Some(cfg) = registry::lookup_by_language(&key.1) else {
                    continue;
                };
                if let Some(root) = self.reprobe(&key, cfg, true).await {
                    let _ = self.ensure_server_handle(&key.0, &root, &key.1).await;
                }
            }
        })
    }

    async fn run_probe(
        &self,
        dep: &DependencyModel,
        cfg: &LanguageServerConfig,
        root: &Path,
    ) -> DependencyProbe {
        let ctx = ProbeCtx {
            root,
            server_bin: find_on_path(cfg.command),
            npm_global_root: self.npm_global_root().await,
            vst_home: &self.vst_home,
        };
        (dep.probe)(&ctx)
    }

    /// `npm root -g`, run at most once per daemon lifetime (2 s timeout;
    /// `None` when npm isn't on PATH).
    async fn npm_global_root(&self) -> Option<PathBuf> {
        if let Some(overridden) = self.npm_root_override.lock().unwrap().clone() {
            return overridden;
        }
        self.npm_root.get_or_init(query_npm_root).await.clone()
    }

    /// For tests: pin the `npm root -g` result instead of running npm.
    pub fn set_npm_global_root(&self, root: Option<PathBuf>) {
        *self.npm_root_override.lock().unwrap() = Some(root);
    }

    /// For tests: shorten the dependency re-probe throttle and the crash
    /// restart backoff schedule (the attempt cap stays
    /// `failure::MAX_CRASH_RESTARTS`; the last delay repeats).
    pub fn set_timing(&self, reprobe_interval: Duration, crash_backoff: Vec<Duration>) {
        *self.timing.lock().unwrap() = Timing {
            reprobe_interval,
            crash_backoff,
        };
    }

    /// Clears a latched failure (and crash history), stops any live server
    /// for `lang`, and spawns it again now. A `Missing` probe gets its one
    /// real spawn attempt back. Spawn-time failures latch as usual — the
    /// caller reads them back from `status_with_failure`.
    pub async fn restart(
        &self,
        workspace: &WorkspaceKey,
        root: &Path,
        lang: &str,
    ) -> Result<(), LspError> {
        let cfg = registry::lookup_by_language(lang).ok_or(LspError::Unsupported)?;
        let key = (workspace.clone(), cfg.language.to_string());
        {
            let mut servers = self.servers.lock().await;
            if let Some(old) = servers.remove(&key) {
                // Stopped first, so its lifecycle task treats the exit as
                // deliberate instead of recording a crash.
                *old.status.write().await = LspStatus::Stopped;
                if let Some(mut child) = old.child.lock().await.take() {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
            }
        }
        self.failures.lock().await.remove(&key);
        self.crash_history.lock().await.remove(&key);
        {
            let mut guard = self.probe_guard.lock().await;
            if guard.get(&key) == Some(&ProbeGuard::Spent) {
                guard.remove(&key);
            }
        }
        match self
            .ensure_server_handle(workspace, root, cfg.language)
            .await
        {
            Ok(_) | Err(LspError::Failed(_)) | Err(LspError::NotFound) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Host-wide survey of every registered language server: whether its
    /// command is on the daemon host's PATH, plus a runnable install command
    /// / note for the missing ones. No workspace resolution, no async I/O
    /// beyond a `$PATH` scan — infallible.
    pub fn language_survey(&self) -> Vec<vst_types::rest::lsp::LspLanguageSurveyEntry> {
        registry::all()
            .iter()
            .map(|cfg| vst_types::rest::lsp::LspLanguageSurveyEntry {
                language: cfg.language.to_string(),
                display_name: cfg.display_name.to_string(),
                command: cfg.command.to_string(),
                installed_on_host: binary_on_path(cfg.command),
                install_command: cfg.install_command.map(|s| s.to_string()),
                install_note: cfg.install_note.map(|s| s.to_string()),
            })
            .collect()
    }

    /// For tests: manually insert a ServerHandle
    pub async fn insert_server_handle(
        &self,
        key: WorkspaceKey,
        lang: String,
        handle: ServerHandle,
    ) {
        self.servers.lock().await.insert((key, lang), handle);
    }

    /// For tests: get a ServerHandle
    pub async fn get_server_handle(&self, key: &WorkspaceKey, lang: &str) -> Option<ServerHandle> {
        self.servers
            .lock()
            .await
            .get(&(key.clone(), lang.to_string()))
            .cloned()
    }

    /// For tests: insert an Arc<FileWatcher>
    pub async fn insert_watcher(&self, key: WorkspaceKey, watcher: Arc<FileWatcher>) {
        self.watchers.lock().await.insert(key, watcher);
    }

    /// For tests: get a watcher
    pub async fn get_watcher(&self, key: &WorkspaceKey) -> Option<Arc<FileWatcher>> {
        self.watchers.lock().await.get(key).cloned()
    }

    pub async fn get_or_mint_external_token(
        &self,
        workspace: &WorkspaceKey,
        canonical_path: &Path,
    ) -> String {
        let mut tokens_map = self.external_tokens.lock().await;
        let entry = tokens_map
            .entry(workspace.clone())
            .or_insert_with(ExternalTokenMap::new);
        entry.get_or_mint(canonical_path)
    }

    pub async fn resolve_external_token(
        &self,
        workspace: &WorkspaceKey,
        token: &str,
    ) -> Option<PathBuf> {
        let tokens_map = self.external_tokens.lock().await;
        tokens_map.get(workspace).and_then(|m| m.resolve(token))
    }

    /// For tests: directly insert an external token mapping
    pub async fn insert_external_token(
        &self,
        workspace: WorkspaceKey,
        token: String,
        path: PathBuf,
    ) {
        let mut tokens_map = self.external_tokens.lock().await;
        let entry = tokens_map
            .entry(workspace)
            .or_insert_with(ExternalTokenMap::new);
        entry.tokens.insert(token.clone(), path.clone());
        entry.paths.insert(path, token.clone());
        entry.order.push_back(token);
    }

    pub async fn has_ever_been_ready(&self, workspace: &WorkspaceKey, lang: &str) -> bool {
        self.ever_ready
            .lock()
            .await
            .contains(&(workspace.clone(), lang.to_string()))
    }

    /// What to surface as `degraded` for a live server: its health warning
    /// (`warning`), else the dependency probe's note (`info`, e.g. running on
    /// a fallback TypeScript). `None` when not up, or healthy with no note.
    pub async fn degraded_info(&self, workspace: &WorkspaceKey, path: &str) -> Option<LspDegraded> {
        if let Some(message) = self.degraded(workspace, path).await {
            return Some(LspDegraded {
                message,
                level: LspDegradedLevel::Warning,
            });
        }
        let key = (workspace.clone(), lang_for_path(path)?);
        let handle = self.servers.lock().await.get(&key).cloned()?;
        if matches!(
            *handle.status.read().await,
            LspStatus::Error | LspStatus::Stopped
        ) {
            return None;
        }
        let note = self.notes.lock().await.get(&key).cloned()?;
        Some(LspDegraded {
            message: note,
            level: LspDegradedLevel::Info,
        })
    }

    /// The health warning/error a live server last reported via
    /// `experimental/serverStatus`, for the language handling `path`.
    /// `None` when there's no live server or it's healthy.
    pub async fn degraded(&self, workspace: &WorkspaceKey, path: &str) -> Option<String> {
        let lang = lang_for_path(path)?;
        let handle = self
            .servers
            .lock()
            .await
            .get(&(workspace.clone(), lang))
            .cloned()?;
        if matches!(
            *handle.status.read().await,
            LspStatus::Error | LspStatus::Stopped
        ) {
            return None;
        }
        let message = handle.health.read().await.clone();
        message
    }

    // Each parameter is a distinct piece of request context (workspace,
    // language, file, request kind, cursor position, feature flag); bundling
    // them into a struct just to satisfy this lint would obscure call sites
    // more than it would clarify this signature.
    #[allow(clippy::too_many_arguments)]
    pub async fn request(
        &self,
        workspace: WorkspaceKey,
        root: &Path,
        lang: &str,
        file: LspFileRef,
        kind: LspRequestKind,
        pos: Option<(u32, u32)>,
        enabled: bool,
    ) -> Result<LspResponse, LspError> {
        if !enabled {
            return Err(LspError::Disabled);
        }

        let (abs_path, uri) = match file {
            LspFileRef::Workspace { path: rel_path } => {
                // Path confinement: reject absolute / escaping / sensitive paths
                // (they'd let the language server open any readable host file).
                let canon = resolve_workspace_path(root, &rel_path)?;
                let uri = path_to_uri(&canon);
                (canon, uri)
            }
            LspFileRef::External { token } => {
                let canon = self
                    .resolve_external_token(&workspace, &token)
                    .await
                    .ok_or(LspError::UnknownExternalToken)?;

                if !canon.is_file() || is_sensitive_path(&canon, Some(&self.vst_home)) {
                    return Err(LspError::UnknownExternalToken);
                }

                let ext = canon.extension().and_then(|s| s.to_str()).unwrap_or("");
                let file_cfg = registry::lookup(ext);
                if let Some(cfg) = file_cfg {
                    if cfg.language != lang {
                        return Err(LspError::Unsupported);
                    }
                } else {
                    return Err(LspError::Unsupported);
                }

                let uri = path_to_uri(&canon);
                (canon, uri)
            }
        };

        // 1. Look up or lazily spawn ServerHandle for (workspace, lang) — spawn-on-first-use.
        let handle = self.ensure_server_handle(&workspace, root, lang).await?;

        // 1.5. Wait for the initialize handshake to complete before sending
        // didOpen or any request. Sending traffic before `initialized` crashes
        // LSP-conformant servers (rust-analyzer exits with "expected initialized
        // notification"), which previously left status stuck at Starting forever.
        if !*handle.initialized.borrow() {
            // Resolves when the latch is set true, or returns Err if the init
            // task ended without completing (the handle's status will be Error).
            let _ = handle.initialized.clone().changed().await;
        }
        if *handle.status.read().await == LspStatus::Error {
            let key = (workspace.clone(), lang.to_string());
            return Err(match self.failures.lock().await.get(&key) {
                Some(rec) => LspError::Failed(Box::new(rec.failure.clone())),
                None => LspError::ProcessDied,
            });
        }

        // 2. Ensure a didOpen has been sent for that URI on this handle
        {
            let mut open_files = handle.open_files.lock().await;
            if !open_files.contains(&abs_path) {
                let content = tokio::fs::read_to_string(&abs_path)
                    .await
                    .unwrap_or_default();
                let did_open = json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": lang,
                        "version": 1,
                        "text": content
                    }
                });
                let _ = handle.client.notify("textDocument/didOpen", did_open);
                open_files.insert(abs_path.clone());
                handle
                    .file_versions
                    .lock()
                    .await
                    .insert(abs_path.clone(), 1);
            }
        }

        // 3. If ServerHandle.status is Starting or Indexing, return LspError::Starting immediately
        let current_status = *handle.status.read().await;
        if current_status == LspStatus::Starting || current_status == LspStatus::Indexing {
            return Err(LspError::Starting);
        }
        if current_status == LspStatus::Idle {
            *handle.status.write().await = LspStatus::Ready;
        }
        self.ever_ready
            .lock()
            .await
            .insert((workspace.clone(), lang.to_string()));
        *handle.last_request.write().await = Instant::now();

        // 5. Forward the LSP request over the handle's JSON-RPC client, await with 10s timeout
        match kind {
            LspRequestKind::Definition => {
                let (line, character) = pos.unwrap_or((0, 0));
                let params = json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": line, "character": character }
                });
                let res = handle
                    .client
                    .request("textDocument/definition", params)
                    .await?;
                let locations = parse_definition_response(res).await;
                Ok(LspResponse::Definition(locations))
            }
            LspRequestKind::Hover => {
                let (line, character) = pos.unwrap_or((0, 0));
                let params = json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": line, "character": character }
                });
                let res = handle.client.request("textDocument/hover", params).await?;
                Ok(LspResponse::Hover(res))
            }
            LspRequestKind::References => {
                let (line, character) = pos.unwrap_or((0, 0));
                let params = json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": line, "character": character },
                    "context": { "includeDeclaration": true }
                });
                let res = handle
                    .client
                    .request("textDocument/references", params)
                    .await?;
                let targets = parse_references_response(res, Some(&abs_path), pos).await;
                Ok(LspResponse::References(targets))
            }
            LspRequestKind::Outline => {
                let params = json!({
                    "textDocument": { "uri": uri }
                });
                let res = handle
                    .client
                    .request("textDocument/documentSymbol", params)
                    .await?;
                Ok(LspResponse::Outline(res))
            }
        }
    }

    async fn ensure_server_handle(
        &self,
        workspace: &WorkspaceKey,
        root: &Path,
        lang: &str,
    ) -> Result<ServerHandle, LspError> {
        // Resolve the once-per-daemon `npm root -g` (up to 2 s) BEFORE taking
        // the global `servers` lock: `plan_launch`'s dependency probe needs it,
        // and running it under the lock stalled every other workspace's
        // status/requests behind the first TypeScript spawn.
        if registry::lookup_by_language(lang)
            .or_else(|| registry::lookup(lang))
            .is_some_and(|cfg| cfg.dependency.is_some())
        {
            let _ = self.npm_global_root().await;
        }
        let mut servers = self.servers.lock().await;
        let key = (workspace.clone(), lang.to_string());

        if let Some(handle) = servers.get(&key) {
            let status = *handle.status.read().await;
            if status != LspStatus::Stopped && status != LspStatus::Error {
                return Ok(handle.clone());
            }
        }

        // A latched start failure is answered immediately — never respawned
        // per request (that was a respawn storm: one doomed process per
        // hover/outline/click).
        if let Some(rec) = self.failures.lock().await.get(&key) {
            return Err(LspError::Failed(Box::new(rec.failure.clone())));
        }

        // Must spawn new server
        let cfg = registry::lookup_by_language(lang)
            .or_else(|| registry::lookup(lang))
            .ok_or(LspError::Unsupported)?;

        let plan = match self.plan_launch(&key, root, cfg).await {
            Ok(plan) => plan,
            Err(failure) => {
                let failure = self.latch(&key, root, failure, true).await;
                drop(servers);
                // Watch package.json / lockfiles so an install clears the latch.
                self.ensure_watcher(workspace, root).await;
                return Err(LspError::Failed(Box::new(failure)));
            }
        };

        // Kill any stale/errored process before replacing the handle, so the
        // old Child doesn't leak (it would otherwise just be dropped).
        if let Some(old) = servers.remove(&key) {
            *old.status.write().await = LspStatus::Stopped;
            if let Some(mut child) = old.child.lock().await.take() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }

        let note = plan.note.clone();
        let handle = match self.spawn_server(workspace, root, cfg, plan).await {
            Ok(h) => h,
            Err(SpawnError::NotFound) => return Err(LspError::NotFound),
            Err(SpawnError::Other(msg)) => {
                let failure = failure::phase_failure(
                    LspFailureKind::SpawnFailed,
                    cfg.command,
                    Some(&msg),
                    "",
                    None,
                );
                let failure = self.latch(&key, root, failure, false).await;
                return Err(LspError::Failed(Box::new(failure)));
            }
        };
        servers.insert(key.clone(), handle.clone());
        drop(servers);
        {
            let mut notes = self.notes.lock().await;
            match note {
                Some(n) => notes.insert(key, n),
                None => notes.remove(&key),
            };
        }

        // Ensure file watcher is spawned for this workspace (Decision 9)
        self.ensure_watcher(workspace, root).await;

        Ok(handle)
    }

    /// Records a latched failure for `key` and returns it.
    async fn latch(
        &self,
        key: &ServerKey,
        root: &Path,
        failure: LspFailure,
        reprobe: bool,
    ) -> LspFailure {
        warn!("LSP {:?} failed to start: {}", key, failure.summary);
        let now = Instant::now();
        self.failures.lock().await.insert(
            key.clone(),
            FailureRecord {
                failure: failure.clone(),
                at: now,
                last_probe: now,
                root: root.to_path_buf(),
                reprobe,
            },
        );
        failure
    }

    /// Runs the language's dependency probe (if it has one and its binary is
    /// on PATH — a missing binary stays the existing `NotFound`). `Err` = the
    /// failure to latch without spawning anything.
    async fn plan_launch(
        &self,
        key: &ServerKey,
        root: &Path,
        cfg: &'static LanguageServerConfig,
    ) -> Result<LaunchPlan, LspFailure> {
        let mut plan = LaunchPlan {
            init_options: cfg.init_options.clone(),
            note: None,
            pending_dependency: None,
        };
        let Some(dep) = cfg.dependency.filter(|_| binary_on_path(cfg.command)) else {
            return Ok(plan);
        };
        match self.run_probe(&dep, cfg, root).await {
            DependencyProbe::Ok {
                init_options_patch,
                note,
            } => {
                plan.init_options = deps::merge_init_options(plan.init_options, init_options_patch);
                plan.note = note;
                Ok(plan)
            }
            DependencyProbe::Incompatible {
                summary,
                install,
                found,
            } => {
                debug!("LSP dependency probe for {:?}: incompatible ({found})", key);
                Err(failure::dependency_failure(
                    LspFailureKind::IncompatibleDependency,
                    summary,
                    install,
                    None,
                ))
            }
            DependencyProbe::Missing { summary, install } => {
                let failure = failure::dependency_failure(
                    LspFailureKind::MissingDependency,
                    summary,
                    install,
                    None,
                );
                let mut guard = self.probe_guard.lock().await;
                match guard.get(key) {
                    // A real attempt already succeeded despite the probe.
                    Some(ProbeGuard::Disproved) => Ok(plan),
                    // The one real attempt already confirmed it.
                    Some(ProbeGuard::Spent) => Err(failure),
                    // First time: one real spawn, latching only if it fails too.
                    None => {
                        guard.insert(key.clone(), ProbeGuard::Spent);
                        plan.pending_dependency = Some(failure);
                        Ok(plan)
                    }
                }
            }
        }
    }

    async fn spawn_server(
        &self,
        workspace: &WorkspaceKey,
        root: &Path,
        cfg: &'static LanguageServerConfig,
        plan: LaunchPlan,
    ) -> Result<ServerHandle, SpawnError> {
        let mut cmd = tokio::process::Command::new(cfg.command);
        cmd.args(&cfg.args);
        cmd.current_dir(root);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        // Captured into a bounded ring buffer for failure messages. MUST be
        // drained continuously (below) — a full pipe blocks the child.
        cmd.stderr(std::process::Stdio::piped());
        // Backstop: kill the child if the handle/child is dropped without an
        // explicit kill (e.g. a stale handle replaced in ensure_server_handle).
        cmd.kill_on_drop(true);

        for (k, v) in &cfg.extra_env {
            cmd.env(k, v);
        }

        // Decision 3: dedicated CARGO_TARGET_DIR for rust-analyzer
        if cfg.language == "rust" {
            let target_dir = self
                .vst_home
                .join("lsp-target")
                .join(workspace.to_key_string());
            let _ = tokio::fs::create_dir_all(&target_dir).await;
            cmd.env("CARGO_TARGET_DIR", target_dir);
        }

        // Decision 11: Java's per-workspace -data directory
        if cfg.language == "java" {
            let data_dir = self
                .vst_home
                .join("lsp-jdtls-data")
                .join(workspace.to_key_string());
            let _ = tokio::fs::create_dir_all(&data_dir).await;
            cmd.arg("-data").arg(&data_dir);
        }

        // Decision 3: lowered scheduling priority via libc::setpriority
        #[cfg(unix)]
        unsafe {
            cmd.pre_exec(|| {
                libc::setpriority(libc::PRIO_PROCESS, 0, 10);
                Ok(())
            });
        }

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                SpawnError::NotFound
            } else {
                SpawnError::Other(e.to_string())
            }
        })?;

        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let log = Arc::new(std::sync::Mutex::new(ServerLog::default()));
        let (stderr_done_tx, stderr_done) = watch::channel(false);
        match child.stderr.take() {
            Some(stderr) => {
                tokio::spawn(drain_stderr(stderr, log.clone(), stderr_done_tx));
            }
            None => {
                let _ = stderr_done_tx.send(true);
            }
        }

        let (client, channels) = LspClient::new_with_channels(stdout, stdin);
        tokio::spawn(drain_log_messages(channels.log, log.clone()));
        let status = Arc::new(RwLock::new(LspStatus::Starting));
        let last_request = Arc::new(RwLock::new(Instant::now()));
        let open_files = Arc::new(Mutex::new(HashSet::new()));
        let file_versions = Arc::new(Mutex::new(HashMap::new()));
        let child_arc = Arc::new(Mutex::new(Some(child)));

        let (init_tx, init_rx) = watch::channel(false);
        let health = Arc::new(RwLock::new(None));

        let handle = ServerHandle {
            client: client.clone(),
            child: child_arc.clone(),
            status: status.clone(),
            last_request,
            open_files,
            file_versions,
            language: cfg.language.to_string(),
            initialized: init_rx,
            health: health.clone(),
        };

        let task = ServerTask {
            key: (workspace.clone(), cfg.language.to_string()),
            root: root.to_path_buf(),
            cfg,
            pending_dependency: plan.pending_dependency,
            servers: self.servers.clone(),
            failures: self.failures.clone(),
            crash_history: self.crash_history.clone(),
            probe_guard: self.probe_guard.clone(),
            me: self.me.clone(),
            child: child_arc,
            log,
            stderr_done,
            status,
            crash_backoff: self.timing.lock().unwrap().crash_backoff.clone(),
        };
        tokio::spawn(task.run(
            client,
            plan.init_options,
            init_tx,
            channels.progress,
            channels.server_status,
            health,
        ));

        Ok(handle)
    }

    /// Crash-backoff restart: respawns `key` unless the crash record it was
    /// scheduled for has since been cleared or replaced (Retry, another crash).
    // Boxed: spawn_server → lifecycle task → auto_restart → spawn_server is a
    // cycle the compiler can't size as an `async fn`.
    fn auto_restart(
        &self,
        key: ServerKey,
        root: PathBuf,
        crashed_at: Instant,
    ) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            {
                let mut failures = self.failures.lock().await;
                match failures.get(&key) {
                    Some(rec)
                        if rec.at == crashed_at && rec.failure.kind == LspFailureKind::Crashed => {}
                    _ => return,
                }
                failures.remove(&key);
            }
            info!("Restarting crashed language server {:?}", key);
            let _ = self.ensure_server_handle(&key.0, &root, &key.1).await;
        })
    }

    async fn ensure_watcher(&self, workspace: &WorkspaceKey, root: &Path) {
        let mut watchers = self.watchers.lock().await;
        if watchers.contains_key(workspace) {
            return;
        }

        let servers_clone = self.servers.clone();
        let ws_key_clone = workspace.clone();
        let me = self.me.clone();
        let on_changed = Arc::new(move |abs_path_str: String| {
            let servers = servers_clone.clone();
            let ws_key = ws_key_clone.clone();
            let me = me.clone();
            tokio::spawn(async move {
                let abs_path = PathBuf::from(&abs_path_str);
                if is_dependency_manifest(&abs_path) {
                    if let Some(mgr) = me.upgrade() {
                        mgr.reprobe_workspace(&ws_key).await;
                    }
                }
                let guard = servers.lock().await;
                for ((ws, _), handle) in guard.iter() {
                    if ws == &ws_key {
                        let is_open = handle.open_files.lock().await.contains(&abs_path);
                        if is_open {
                            if let Ok(content) = tokio::fs::read_to_string(&abs_path).await {
                                let mut versions = handle.file_versions.lock().await;
                                let ver = versions.entry(abs_path.clone()).or_insert(1);
                                *ver += 1;
                                let uri = path_to_uri(&abs_path);
                                let _ = handle.client.notify(
                                    "textDocument/didChange",
                                    json!({
                                        "textDocument": {
                                            "uri": uri,
                                            "version": *ver
                                        },
                                        "contentChanges": [
                                            { "text": content }
                                        ]
                                    }),
                                );
                            }
                        } else {
                            let uri = path_to_uri(&abs_path);
                            let _ = handle.client.notify(
                                "workspace/didChangeWatchedFiles",
                                json!({
                                    "changes": [
                                        { "uri": uri, "type": 2 }
                                    ]
                                }),
                            );
                        }
                    }
                }
            });
        });

        let servers_clone_del = self.servers.clone();
        let ws_key_clone_del = workspace.clone();
        let on_deleted = Arc::new(move |abs_path_str: String| {
            let servers = servers_clone_del.clone();
            let ws_key = ws_key_clone_del.clone();
            tokio::spawn(async move {
                let abs_path = PathBuf::from(&abs_path_str);
                let guard = servers.lock().await;
                for ((ws, _), handle) in guard.iter() {
                    if ws == &ws_key {
                        let uri = path_to_uri(&abs_path);
                        let _ = handle.client.notify(
                            "workspace/didChangeWatchedFiles",
                            json!({
                                "changes": [
                                    { "uri": uri, "type": 3 }
                                ]
                            }),
                        );
                    }
                }
            });
        });

        let callbacks = WatcherCallbacks {
            on_changed,
            on_deleted,
            on_error: Arc::new(|err| warn!("LSP FileWatcher error: {err}")),
        };

        let root_buf = root.to_path_buf();
        let watcher = Arc::new(FileWatcher::new(callbacks, root_buf.clone()));
        let watcher_clone = watcher.clone();
        let root_str = root_buf.to_string_lossy().into_owned();

        let _ = tokio::task::spawn_blocking(move || {
            let _ = watcher_clone.spawn(&root_str);
        })
        .await;

        watchers.insert(workspace.clone(), watcher);
    }
}

/// Everything a server's lifecycle task needs once spawned: it runs
/// `initialize`, drives readiness, and on failure classifies it BY PHASE
/// (never by matching server text, except the registry's hint backstop) and
/// latches it in the manager's failure map.
struct ServerTask {
    key: ServerKey,
    root: PathBuf,
    cfg: &'static LanguageServerConfig,
    pending_dependency: Option<LspFailure>,
    servers: ServerMap,
    failures: FailureMap,
    crash_history: Arc<Mutex<HashMap<ServerKey, CrashHistory>>>,
    probe_guard: Arc<Mutex<HashMap<ServerKey, ProbeGuard>>>,
    me: Weak<LspManager>,
    child: Arc<Mutex<Option<tokio::process::Child>>>,
    log: Arc<std::sync::Mutex<ServerLog>>,
    stderr_done: watch::Receiver<bool>,
    status: Arc<RwLock<LspStatus>>,
    crash_backoff: Vec<Duration>,
}

impl ServerTask {
    async fn run(
        self,
        client: Arc<LspClient>,
        init_options: Option<Value>,
        init_tx: watch::Sender<bool>,
        mut progress_rx: mpsc::UnboundedReceiver<ProgressNotification>,
        mut server_status_rx: mpsc::UnboundedReceiver<ServerStatusNotification>,
        health: Arc<RwLock<Option<String>>>,
    ) {
        match client.initialize(&self.root, init_options).await {
            Ok(_) => {
                debug!("LSP initialized successfully");
                if self.pending_dependency.is_some() {
                    // The probe said Missing, yet the server found something.
                    self.probe_guard
                        .lock()
                        .await
                        .insert(self.key.clone(), ProbeGuard::Disproved);
                }
                // The initialize response was received and the `initialized`
                // notification has been sent — release request()/didOpen.
                let _ = init_tx.send(true);
            }
            Err(e) => {
                let (failure, reprobe) = self.classify_init_error(e).await;
                self.record(failure, reprobe).await;
                // A server that refused `initialize` but stayed alive is useless.
                if let Some(mut child) = self.child.lock().await.take() {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                }
                // Drop init_tx so any request() awaiting the latch unblocks
                // (then sees status == Error and the latched failure).
                drop(init_tx);
                client.fail_pending().await;
                return;
            }
        }

        let mut tracker = ReadinessTracker::default();
        let mut saw_signal = false;
        let mut settled = false;
        let settle_delay = tokio::time::sleep(Duration::from_secs(2));
        tokio::pin!(settle_delay);
        let mut ready_pending = false;
        let ready_debounce = tokio::time::sleep(READY_DEBOUNCE);
        tokio::pin!(ready_debounce);
        let mut server_status_open = true;

        loop {
            let readiness = tokio::select! {
                progress = progress_rx.recv() => {
                    match progress {
                        Some(p) => tracker.on_progress(&p.kind, &p.token),
                        None => {
                            // progress channel closed = the reader task hit
                            // EOF / an I/O error = the child process died.
                            break;
                        }
                    }
                }
                server_status = server_status_rx.recv(), if server_status_open => {
                    match server_status {
                        Some(st) => {
                            *health.write().await = health_message(&st);
                            tracker.on_server_status(&st)
                        }
                        None => {
                            // Closes together with the progress channel;
                            // let that branch handle shutdown.
                            server_status_open = false;
                            Readiness::Unchanged
                        }
                    }
                }
                _ = &mut ready_debounce, if ready_pending => {
                    ready_pending = false;
                    Readiness::ReadyNow
                }
                _ = &mut settle_delay, if !saw_signal && !settled => {
                    // Fire at most once: a fired-but-not-reset sleep future
                    // resolves immediately on every poll, which would spin
                    // this loop at 100% CPU if the guard stayed true.
                    settled = true;
                    let mut s = self.status.write().await;
                    if *s == LspStatus::Starting {
                        *s = LspStatus::Ready;
                    }
                    Readiness::Unchanged
                }
            };

            match readiness {
                Readiness::Unchanged => {}
                Readiness::Indexing => {
                    saw_signal = true;
                    ready_pending = false;
                    apply_readiness(&self.status, LspStatus::Indexing).await;
                }
                Readiness::ReadySoon => {
                    saw_signal = true;
                    ready_pending = true;
                    ready_debounce
                        .as_mut()
                        .reset(tokio::time::Instant::now() + READY_DEBOUNCE);
                }
                Readiness::ReadyNow => {
                    saw_signal = true;
                    ready_pending = false;
                    apply_readiness(&self.status, LspStatus::Ready).await;
                }
            }
        }

        // Reader task ended (child died / EOF) after a successful initialize.
        // Fail any requests still awaiting a response, then record a crash
        // (unless the exit was deliberate) and schedule a backoff restart.
        client.fail_pending().await;
        if *self.status.read().await == LspStatus::Stopped {
            return;
        }
        let exit_code = self.exit_code().await;
        let tail = self.log_tail().await;
        let (count, window) = {
            let mut history = self.crash_history.lock().await;
            let h = history.entry(self.key.clone()).or_insert(CrashHistory {
                count: 0,
                first_at: Instant::now(),
            });
            if h.first_at.elapsed() > CRASH_WINDOW {
                *h = CrashHistory {
                    count: 0,
                    first_at: Instant::now(),
                };
            }
            h.count += 1;
            (h.count, h.first_at.elapsed())
        };
        let failure =
            failure::crash_failure(self.cfg.command, count, window.as_secs(), &tail, exit_code);
        let auto_retry = failure.auto_retry;
        let Some(at) = self.record(failure, false).await else {
            return;
        };
        if auto_retry {
            let idx = (count as usize).saturating_sub(1);
            let delay = self
                .crash_backoff
                .get(idx)
                .or(self.crash_backoff.last())
                .copied()
                .unwrap_or(Duration::from_secs(2));
            let (me, key, root) = (self.me.clone(), self.key.clone(), self.root.clone());
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                if let Some(mgr) = me.upgrade() {
                    mgr.auto_restart(key, root, at).await;
                }
            });
        }
    }

    /// Phase classification of an `initialize` failure. Returns the failure
    /// and whether it came from the structural probe (re-probe on change).
    async fn classify_init_error(&self, e: LspClientError) -> (LspFailure, bool) {
        let command = self.cfg.command;
        let server_error = match &e {
            LspClientError::RpcError { message, .. } => Some(message.clone()),
            LspClientError::Io(_) | LspClientError::Json(_) => Some(e.to_string()),
            LspClientError::ChannelClosed | LspClientError::Timeout => None,
        };
        let exit_code = match e {
            LspClientError::ChannelClosed => self.exit_code().await,
            _ => None,
        };
        let tail = self.log_tail().await;

        // The probe said Missing and this guarded real attempt confirmed it.
        if let Some(dep) = &self.pending_dependency {
            let mut f = dep.clone();
            f.message = failure::compose_message(server_error.as_deref(), &tail);
            f.exit_code = exit_code;
            return (f, true);
        }
        // Backstop: probe said Ok, but the server's own words say dependency.
        if let (Some(model), Some(msg)) = (self.cfg.dependency, server_error.as_deref()) {
            if let Some(kind) = model.match_hint(msg) {
                let (summary, install) = (model.describe_hint)(kind, &self.root);
                let mut f = failure::dependency_failure(
                    kind,
                    summary,
                    install,
                    failure::compose_message(Some(msg), &tail),
                );
                // No structural signal to wait for: Retry is the way out.
                f.auto_retry = false;
                return (f, false);
            }
        }
        let kind = match e {
            LspClientError::ChannelClosed => LspFailureKind::ExitedOnStart,
            LspClientError::Timeout => LspFailureKind::InitTimeout,
            _ => LspFailureKind::InitFailed,
        };
        (
            failure::phase_failure(kind, command, server_error.as_deref(), &tail, exit_code),
            false,
        )
    }

    /// Latches `failure` if this task's server is still the current one for
    /// its key and wasn't stopped on purpose; marks the handle `Error`.
    /// Returns the record timestamp when recorded.
    async fn record(&self, failure: LspFailure, reprobe: bool) -> Option<Instant> {
        // Lock order everywhere: servers → failures.
        let servers = self.servers.lock().await;
        let current = servers
            .get(&self.key)
            .is_some_and(|h| Arc::ptr_eq(&h.status, &self.status));
        let mut status = self.status.write().await;
        if !current || *status == LspStatus::Stopped {
            return None;
        }
        warn!("LSP {:?} failed: {}", self.key, failure.summary);
        let now = Instant::now();
        self.failures.lock().await.insert(
            self.key.clone(),
            FailureRecord {
                failure,
                at: now,
                last_probe: now,
                root: self.root.clone(),
                reprobe,
            },
        );
        *status = LspStatus::Error;
        Some(now)
    }

    /// The child's exit code, waiting up to 500 ms for it to be reaped.
    async fn exit_code(&self) -> Option<i32> {
        for _ in 0..10 {
            {
                let mut guard = self.child.lock().await;
                let child = guard.as_mut()?;
                if let Ok(Some(st)) = child.try_wait() {
                    return st.code();
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        None
    }

    /// The captured stderr / log tail, after giving the stderr drain up to
    /// 300 ms to reach EOF (so a dying server's last words are included).
    async fn log_tail(&self) -> String {
        let mut done = self.stderr_done.clone();
        let _ = tokio::time::timeout(Duration::from_millis(300), done.wait_for(|d| *d)).await;
        self.log.lock().unwrap().tail(MESSAGE_CAP)
    }
}

/// Drains a server's stderr into `log` line by line until EOF. Must run
/// continuously: an undrained pipe blocks a chatty child once it fills.
async fn drain_stderr(
    mut stderr: tokio::process::ChildStderr,
    log: Arc<std::sync::Mutex<ServerLog>>,
    done: watch::Sender<bool>,
) {
    // Bytes kept per line before the rest of it is skipped (ServerLog caps
    // further); bounds memory for a newline-free flood.
    const PARTIAL_CAP: usize = 4096;
    let mut chunk = [0u8; 8192];
    let mut partial: Vec<u8> = Vec::new();
    loop {
        let n = match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &b in &chunk[..n] {
            if b == b'\n' {
                log.lock().unwrap().push(&String::from_utf8_lossy(&partial));
                partial.clear();
            } else if partial.len() < PARTIAL_CAP {
                partial.push(b);
            }
        }
    }
    if !partial.is_empty() {
        log.lock().unwrap().push(&String::from_utf8_lossy(&partial));
    }
    let _ = done.send(true);
}

/// Copies `window/logMessage` / `showMessage` into `log`: every error and
/// warning, plus the first few info/log lines (e.g. ts-ls's "Using
/// Typescript version …"). Stored for display only — never parsed.
async fn drain_log_messages(
    mut rx: mpsc::UnboundedReceiver<ServerLogMessage>,
    log: Arc<std::sync::Mutex<ServerLog>>,
) {
    const INFO_BUDGET: usize = 20;
    let mut info_seen = 0;
    while let Some(msg) = rx.recv().await {
        if msg.level > 2 {
            if info_seen >= INFO_BUDGET {
                continue;
            }
            info_seen += 1;
        }
        let tag = match msg.level {
            1 => "error",
            2 => "warn",
            3 => "info",
            _ => "log",
        };
        let mut log = log.lock().unwrap();
        for line in msg.text.lines() {
            log.push(&format!("[{tag}] {line}"));
        }
    }
}

async fn query_npm_root() -> Option<PathBuf> {
    if !binary_on_path("npm") {
        return None;
    }
    let mut cmd = tokio::process::Command::new("npm");
    cmd.args(["root", "-g"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(2), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!root.is_empty()).then(|| PathBuf::from(root))
}

fn is_dependency_manifest(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| DEPENDENCY_MANIFESTS.contains(&n))
}

/// Registry language for a file path (or bare extension).
fn lang_for_path(path: &str) -> Option<String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or(path);
    registry::lookup(ext).map(|cfg| cfg.language.to_string())
}

fn find_on_path(cmd: &str) -> Option<PathBuf> {
    let path_var = std::env::var("PATH").ok()?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(cmd))
        .find(|full| full.is_file())
}

fn binary_on_path(cmd: &str) -> bool {
    find_on_path(cmd).is_some()
}

/// One `Location`/`LocationLink` item, decoded: path from the (percent-decoded)
/// URI, start position, and the end column when the range is single-line.
struct ParsedLocation {
    abs_path: PathBuf,
    line: u32,
    character: u32,
    end_character: Option<u32>,
}

fn response_items(val: Value) -> Vec<Value> {
    match val {
        Value::Null => vec![],
        Value::Array(arr) => arr,
        other => vec![other],
    }
}

fn parse_location_item(item: &Value) -> Option<ParsedLocation> {
    // Can be Location { uri, range } or LocationLink { targetUri,
    // targetSelectionRange | targetRange } — prefer the selection (the name).
    let uri = item
        .get("uri")
        .or_else(|| item.get("targetUri"))
        .and_then(|u| u.as_str())?;
    let abs_path = uri_to_path(uri)?;

    let range = item
        .get("range")
        .or_else(|| item.get("targetSelectionRange"))
        .or_else(|| item.get("targetRange"));
    let pos = |key: &str, field: &str| {
        range
            .and_then(|r| r.get(key))
            .and_then(|p| p.get(field))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
    };
    let line = pos("start", "line").unwrap_or(0);
    let character = pos("start", "character").unwrap_or(0);
    let end_character = match (pos("end", "line"), pos("end", "character")) {
        (Some(end_line), Some(end_char)) if end_line == line => Some(end_char),
        _ => None,
    };

    Some(ParsedLocation {
        abs_path,
        line,
        character,
        end_character,
    })
}

async fn parse_definition_response(val: Value) -> Vec<LocationTarget> {
    let mut targets = Vec::new();
    for item in response_items(val) {
        let Some(loc) = parse_location_item(&item) else {
            continue;
        };
        let preview = read_line_preview(&loc.abs_path, loc.line as usize).await;
        targets.push(LocationTarget {
            abs_path: loc.abs_path,
            line: loc.line,
            character: loc.character,
            end_character: loc.end_character,
            preview,
        });
    }
    targets
}

/// True when the request position (the click) falls inside this reference's
/// range — the clicked occurrence is the one we report as the declaration when
/// the server doesn't say. Matching only the exact start column lost the badge
/// whenever the click landed mid-identifier.
fn contains_request_pos(loc: &ParsedLocation, req_path: &Path, req_pos: (u32, u32)) -> bool {
    let (rl, rc) = req_pos;
    if loc.abs_path != req_path || loc.line != rl || rc < loc.character {
        return false;
    }
    match loc.end_character {
        Some(end) => rc < end.max(loc.character.saturating_add(1)),
        // Multi-line range: anything at/after the start on the start line.
        None => true,
    }
}

async fn parse_references_response(
    val: Value,
    req_path: Option<&Path>,
    req_pos: Option<(u32, u32)>,
) -> Vec<ReferenceTarget> {
    let mut targets = Vec::new();
    for item in response_items(val) {
        let Some(loc) = parse_location_item(&item) else {
            continue;
        };
        let is_declaration = item
            .get("isDeclaration")
            .and_then(|b| b.as_bool())
            .unwrap_or_else(|| match (req_path, req_pos) {
                (Some(rp), Some(pos)) => contains_request_pos(&loc, rp, pos),
                _ => false,
            });
        let preview = read_line_preview(&loc.abs_path, loc.line as usize).await;
        targets.push(ReferenceTarget {
            abs_path: loc.abs_path,
            line: loc.line,
            character: loc.character,
            end_character: loc.end_character,
            preview,
            is_declaration,
        });
    }
    targets
}

/// The raw source line — NOT trimmed, because `character`/`end_character` are
/// UTF-16 columns into the untrimmed line and the UI indexes the preview with
/// them. `str::lines` already drops the `\n` / `\r\n` terminator.
async fn read_line_preview(path: &Path, line: usize) -> String {
    if let Ok(content) = tokio::fs::read_to_string(path).await {
        if let Some(l) = content.lines().nth(line) {
            return l.trim_end_matches('\r').to_string();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture(dir: &Path) -> PathBuf {
        let file = dir.join("lib.rs");
        std::fs::write(
            &file,
            "pub struct Foo;\r\nimpl Foo {\n    pub fn subscribe(&self) {}\n}\n",
        )
        .unwrap();
        file
    }

    fn reference(file: &Path, line: u32, start: u32, end_line: u32, end: u32) -> Value {
        json!({
            "uri": path_to_uri(file),
            "range": {
                "start": { "line": line, "character": start },
                "end": { "line": end_line, "character": end }
            }
        })
    }

    #[tokio::test]
    async fn preview_is_raw_line_and_end_character_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let file = write_fixture(dir.path());
        let targets = parse_references_response(
            json!([
                reference(&file, 2, 11, 2, 20),
                reference(&file, 0, 11, 0, 14)
            ]),
            None,
            None,
        )
        .await;
        assert_eq!(targets[0].preview, "    pub fn subscribe(&self) {}");
        assert_eq!(
            &targets[0].preview
                [targets[0].character as usize..targets[0].end_character.unwrap() as usize],
            "subscribe"
        );
        // CRLF line: the `\r` is stripped too.
        assert_eq!(targets[1].preview, "pub struct Foo;");
        assert_eq!(targets[1].end_character, Some(14));
    }

    #[tokio::test]
    async fn multi_line_range_has_no_end_character() {
        let dir = tempfile::tempdir().unwrap();
        let file = write_fixture(dir.path());
        let targets = parse_definition_response(json!([reference(&file, 1, 0, 3, 1)])).await;
        assert_eq!(targets[0].end_character, None);
        assert_eq!(targets[0].preview, "impl Foo {");
    }

    #[tokio::test]
    async fn is_declaration_when_click_is_mid_identifier() {
        let dir = tempfile::tempdir().unwrap();
        let file = write_fixture(dir.path());
        let items = json!([
            reference(&file, 2, 11, 2, 20),
            reference(&file, 0, 11, 0, 14)
        ]);
        // Click at col 14 — inside `subscribe` (11..20), not its first char.
        let targets = parse_references_response(items.clone(), Some(&file), Some((2, 14))).await;
        assert!(targets[0].is_declaration);
        assert!(!targets[1].is_declaration);
        // Exclusive end: col 20 is just past the identifier.
        let targets = parse_references_response(items, Some(&file), Some((2, 20))).await;
        assert!(!targets[0].is_declaration);
    }

    #[tokio::test]
    async fn percent_encoded_uris_resolve_to_real_paths() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("my proj");
        std::fs::create_dir_all(&sub).unwrap();
        let file = write_fixture(&sub);
        let uri = path_to_uri(&file);
        assert!(uri.contains("my%20proj"));
        let targets = parse_definition_response(json!({
            "uri": uri,
            "range": { "start": { "line": 0, "character": 11 }, "end": { "line": 0, "character": 14 } }
        }))
        .await;
        assert_eq!(targets[0].abs_path, file);
        assert_eq!(targets[0].preview, "pub struct Foo;");
    }

    fn server_status(health: ServerHealth, quiescent: bool) -> ServerStatusNotification {
        ServerStatusNotification {
            health,
            quiescent,
            message: None,
        }
    }

    #[test]
    fn progress_path_debounces_ready_between_phases() {
        let mut t = ReadinessTracker::default();
        let (a, b) = (json!("fetch"), json!(7));
        assert_eq!(t.on_progress(&ProgressKind::Begin, &a), Readiness::Indexing);
        assert_eq!(
            t.on_progress(&ProgressKind::Report, &a),
            Readiness::Unchanged
        );
        // Last token ended: Ready only after the debounce...
        assert_eq!(t.on_progress(&ProgressKind::End, &a), Readiness::ReadySoon);
        // ...which the next phase's begin cancels (the loop clears ready_pending).
        assert_eq!(t.on_progress(&ProgressKind::Begin, &b), Readiness::Indexing);
        assert_eq!(t.on_progress(&ProgressKind::Begin, &a), Readiness::Indexing);
        assert_eq!(t.on_progress(&ProgressKind::End, &b), Readiness::Unchanged);
        assert_eq!(t.on_progress(&ProgressKind::End, &a), Readiness::ReadySoon);
    }

    #[test]
    fn progress_tokens_are_distinguished_by_type() {
        // `1` and `"1"` are different LSP tokens.
        let mut t = ReadinessTracker::default();
        t.on_progress(&ProgressKind::Begin, &json!(1));
        t.on_progress(&ProgressKind::Begin, &json!("1"));
        assert_eq!(
            t.on_progress(&ProgressKind::End, &json!(1)),
            Readiness::Unchanged
        );
        assert_eq!(
            t.on_progress(&ProgressKind::End, &json!("1")),
            Readiness::ReadySoon
        );
    }

    #[test]
    fn server_status_is_authoritative_once_seen() {
        let mut t = ReadinessTracker::default();
        let tok = json!("cargo-check");
        assert_eq!(
            t.on_server_status(&server_status(ServerHealth::Ok, false)),
            Readiness::Indexing
        );
        // Progress no longer drives readiness (e.g. a flycheck run).
        assert_eq!(
            t.on_progress(&ProgressKind::Begin, &tok),
            Readiness::Unchanged
        );
        assert_eq!(
            t.on_progress(&ProgressKind::End, &tok),
            Readiness::Unchanged
        );
        assert_eq!(
            t.on_server_status(&server_status(ServerHealth::Warning, true)),
            Readiness::ReadyNow
        );
    }

    #[test]
    fn health_message_only_for_warning_or_error() {
        assert_eq!(health_message(&server_status(ServerHealth::Ok, true)), None);
        let mut st = server_status(ServerHealth::Warning, true);
        st.message = Some("Failed to read Cargo metadata".into());
        assert_eq!(
            health_message(&st).as_deref(),
            Some("Failed to read Cargo metadata")
        );
        assert_eq!(
            health_message(&server_status(ServerHealth::Error, true)).as_deref(),
            Some("Language server reported an error")
        );
    }

    #[tokio::test]
    async fn apply_readiness_never_overwrites_terminal_or_idle() {
        let status = RwLock::new(LspStatus::Error);
        apply_readiness(&status, LspStatus::Ready).await;
        assert_eq!(*status.read().await, LspStatus::Error);

        let status = RwLock::new(LspStatus::Idle);
        apply_readiness(&status, LspStatus::Ready).await;
        assert_eq!(*status.read().await, LspStatus::Idle);
        apply_readiness(&status, LspStatus::Indexing).await;
        assert_eq!(*status.read().await, LspStatus::Indexing);
        apply_readiness(&status, LspStatus::Ready).await;
        assert_eq!(*status.read().await, LspStatus::Ready);
    }

    #[tokio::test]
    async fn non_file_uris_are_skipped() {
        let targets = parse_definition_response(json!([{
            "uri": "rust-analyzer-builtin:///core",
            "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } }
        }]))
        .await;
        assert!(targets.is_empty());
    }
}
