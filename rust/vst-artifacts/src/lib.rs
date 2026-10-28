// `deny`, not `forbid`: exactly one audited `fcntl(F_GETPATH)` in `reader::fd_real_path`.
#![deny(unsafe_code)]
//! `vst-artifacts` — the single owner of per-scope artifacts: files agents
//! wrote, captured, capped, batched into `artifact:*` events and served only
//! through the hardened reader.
//!
//! Dependency direction (AGENTS.md): this crate depends on `vst-types` and
//! `vst-store` only. Producers (`vst-agents`) see the `ArtifactSink` trait from
//! `vst-types`; per-CLI parsing never enters here. `vst-routes`/`vst-lsp`
//! depend on this crate for the read gate and the denylist, never the reverse.

pub mod batcher;
pub mod eligibility;
pub mod hashing;
pub mod intake;
pub mod paths;
pub mod ratelimit;
pub mod reader;
pub mod resolver;

mod maintenance;
mod pipeline;
mod service;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{broadcast, Semaphore};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use vst_store::{StoreError, StoreHandle};
use vst_types::artifacts::{
    AddedVia, ArtifactRow, ArtifactSink, FileEffect, ScopeKey, WriteContext,
};
use vst_types::Broadcaster;

pub use paths::{CanonKey, ConfineError, PathKeyer, VolumeProbe};
pub use reader::{DenyCtx, ReadOutcome};
pub use resolver::{ScopeResolver, SessionScope, StoreResolver};

use batcher::Batcher;
use intake::Intake;
use ratelimit::RateLimiter;

/// An artifact row id.
pub type ArtifactId = String;

/// Concurrent hash/measure jobs (intake and background rehash share them).
const HASH_PERMITS: usize = 4;
/// Debounce of lazy revalidation per row.
#[doc(hidden)]
pub const REVALIDATE_DEBOUNCE: Duration = Duration::from_secs(2);
/// Registered roots are cached this long between denylist checks.
const DENY_TTL: Duration = Duration::from_secs(2);

/// What happened to a row; for consumers that follow artifacts (`vst-review`).
///
/// On `RecvError::Lagged` the subscriber MUST call [`ArtifactsHandle::list`]
/// for the scope to resync.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArtifactChange {
    Written {
        scope: ScopeKey,
        id: ArtifactId,
        path: PathBuf,
    },
    Moved {
        scope: ScopeKey,
        id: ArtifactId,
        from: PathBuf,
        to: PathBuf,
    },
    Missing {
        scope: ScopeKey,
        id: ArtifactId,
        path: PathBuf,
    },
    Removed {
        scope: ScopeKey,
        id: ArtifactId,
    },
}

#[derive(Debug)]
pub enum ArtifactError {
    /// Unknown, hidden or already removed artifact.
    NotFound,
    /// Pinning would exceed the per-scope cap.
    PinLimit,
    Store(StoreError),
}

impl std::fmt::Display for ArtifactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArtifactError::NotFound => write!(f, "artifact not found"),
            ArtifactError::PinLimit => write!(f, "pin limit reached"),
            ArtifactError::Store(e) => write!(f, "store error: {e}"),
        }
    }
}

impl std::error::Error for ArtifactError {}

impl From<StoreError> for ArtifactError {
    fn from(e: StoreError) -> Self {
        ArtifactError::Store(e)
    }
}

/// Why a whole `vst artifact add` request was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum AddError {
    /// Empty or oversize path list (400).
    InvalidRequest(String),
    /// Unknown spawn token (404).
    UnknownSession,
    /// The session is archived (403).
    SessionArchived,
    /// Token bucket empty (429).
    RateLimited,
}

/// Visible rows of a scope plus the counters the list response carries.
#[derive(Clone, Debug, PartialEq)]
pub struct ListResult {
    /// Per-scope event counter, read BEFORE the rows.
    pub rev: u64,
    /// All rows counting toward the cap, hidden included.
    pub total: u32,
    pub items: Vec<ArtifactRow>,
}

pub(crate) struct Inner {
    pub store: StoreHandle,
    pub batcher: Arc<Batcher>,
    pub resolver: Arc<dyn ScopeResolver>,
    pub keyer: PathKeyer,
    pub intake: Intake,
    pub hash_sem: Arc<Semaphore>,
    pub drain_lock: tokio::sync::Mutex<()>,
    pub limiter: RateLimiter,
    pub changes: broadcast::Sender<ArtifactChange>,
    /// Last revalidation per row id (debounce).
    pub checked: Mutex<HashMap<String, Instant>>,
    pub stat_count: AtomicU64,
    /// Rows queued/running in the background hash pool, per scope.
    pub rehash: Mutex<HashMap<ScopeKey, HashSet<String>>>,
    pub deny_cache: Mutex<Option<(Instant, Arc<DenyCtx>)>>,
}

impl Inner {
    pub(crate) fn emit_change(&self, c: ArtifactChange) {
        let _ = self.changes.send(c);
    }

    /// Denylist inputs from the resolver, cached briefly (registered roots
    /// clone the whole project list).
    pub(crate) async fn deny_ctx(&self) -> Arc<DenyCtx> {
        if let Some((at, ctx)) = &*self.deny_cache.lock().unwrap() {
            if at.elapsed() < DENY_TTL {
                return ctx.clone();
            }
        }
        let ctx = Arc::new(DenyCtx {
            vst_home: self.resolver.vst_home(),
            registered_roots: self.resolver.registered_roots().await,
        });
        *self.deny_cache.lock().unwrap() = Some((Instant::now(), ctx.clone()));
        ctx
    }

    pub(crate) async fn drain_once(&self) {
        let _guard = self.drain_lock.lock().await;
        let items = self.intake.take();
        if !items.is_empty() {
            self.process(items, AddedVia::Capture).await;
        }
    }
}

static LAST_MS: AtomicI64 = AtomicI64::new(0);

/// ISO8601 UTC with milliseconds, strictly increasing within the process so
/// `lastWrittenAt` ordering is deterministic even for writes in one millisecond.
pub(crate) fn now_iso() -> String {
    let mut ms = chrono::Utc::now().timestamp_millis();
    let mut prev = LAST_MS.load(Ordering::Relaxed);
    loop {
        if ms <= prev {
            ms = prev + 1;
        }
        match LAST_MS.compare_exchange_weak(prev, ms, Ordering::SeqCst, Ordering::Relaxed) {
            Ok(_) => break,
            Err(p) => prev = p,
        }
    }
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Cheap clonable handle to the artifacts owner (`docs/DAEMON-RUST-APPSTATE-HANDLES.md`).
#[derive(Clone)]
pub struct ArtifactsHandle(pub(crate) Arc<Inner>);

impl ArtifactsHandle {
    pub fn new(
        store: StoreHandle,
        broadcaster: Broadcaster,
        resolver: Arc<dyn ScopeResolver>,
    ) -> Self {
        Self::with_keyer(store, broadcaster, resolver, PathKeyer::default())
    }

    /// Like [`new`](Self::new) with an explicit [`PathKeyer`] (test seam for
    /// the volume probe).
    pub fn with_keyer(
        store: StoreHandle,
        broadcaster: Broadcaster,
        resolver: Arc<dyn ScopeResolver>,
        keyer: PathKeyer,
    ) -> Self {
        let (changes, _) = broadcast::channel(256);
        Self(Arc::new(Inner {
            store,
            batcher: Batcher::new(broadcaster),
            resolver,
            keyer,
            intake: Intake::new(),
            hash_sem: Arc::new(Semaphore::new(HASH_PERMITS)),
            drain_lock: tokio::sync::Mutex::new(()),
            limiter: RateLimiter::new(),
            changes,
            checked: Mutex::new(HashMap::new()),
            stat_count: AtomicU64::new(0),
            rehash: Mutex::new(HashMap::new()),
            deny_cache: Mutex::new(None),
        }))
    }

    /// Spawn the 100 ms intake drain and the 250 ms event flusher. Abort the
    /// returned handle to stop both (after [`shutdown`](Self::shutdown)).
    pub fn start(&self) -> JoinHandle<()> {
        let inner = self.0.clone();
        tokio::spawn(async move {
            let drain = async {
                let mut tick = tokio::time::interval(intake::DRAIN_INTERVAL);
                tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tick.tick().await;
                    inner.drain_once().await;
                }
            };
            tokio::join!(drain, inner.batcher.clone().run());
        })
    }

    /// Graceful shutdown: write what is queued (bounded by `bound`) and flush
    /// the pending events once.
    pub async fn shutdown(&self, bound: Duration) {
        let inner = self.0.clone();
        let _ = tokio::time::timeout(bound, async move { inner.drain_once().await }).await;
        self.0.batcher.flush_pending();
    }

    /// Flush pending events now (tests and shutdown).
    pub fn flush_events(&self) {
        self.0.batcher.flush_pending();
    }

    /// Apply everything queued in the intake now (tests and shutdown).
    pub async fn drain_now(&self) {
        self.0.drain_once().await;
    }

    /// Effects dropped because the intake was full.
    pub fn intake_dropped(&self) -> u64 {
        self.0.intake.dropped()
    }

    /// Count of `lstat`s made by lazy revalidation (observability + tests).
    pub fn revalidation_stat_count(&self) -> u64 {
        self.0.stat_count.load(Ordering::Relaxed)
    }

    /// How many ids the revalidation debounce map holds (tests).
    #[doc(hidden)]
    pub fn revalidation_debounce_len(&self) -> usize {
        self.0.checked.lock().unwrap().len()
    }

    /// Forget the 2 s revalidation debounce (tests).
    #[doc(hidden)]
    pub fn clear_revalidation_debounce(&self) {
        self.0.checked.lock().unwrap().clear();
    }

    /// Per-scope event counter.
    pub fn rev(&self, scope: &ScopeKey) -> u64 {
        self.0.batcher.rev(scope)
    }

    /// Follow what happens to artifact rows. On `Lagged` call [`list`](Self::list).
    pub fn subscribe_changes(&self) -> broadcast::Receiver<ArtifactChange> {
        self.0.changes.subscribe()
    }
}

impl ArtifactSink for ArtifactsHandle {
    fn record(&self, ctx: WriteContext, effects: Vec<FileEffect>) {
        self.0.intake.record(&ctx, effects);
    }
}
