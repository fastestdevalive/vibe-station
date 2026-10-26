//! `UpdateService` — owns update state, runs checks, publishes snapshots.
//!
//! One writer at a time: the daemon mutates state only through this type;
//! every mutation publishes the WHOLE `UpdateStatus` snapshot (clients replace,
//! never merge). Failures of a check are recorded in `lastError`, never
//! returned as `Err` (the check route never 5xx's).

#[cfg(any(test, feature = "test-seams"))]
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::update::UpdateApiErrorCode;
use vst_types::rest::update::{
    InstallMethod, InstallProgress, InstallResult, RestartPending, UpdateError, UpdateErrorKind,
    UpdateReason, UpdateStatus, UpdateTarget,
};

use super::detect::{detect, DetectEnv, RealEnv};
use super::github::{fetch_releases, FetchOutcome, DEFAULT_API_BASE};
use super::platform::{assets_for, platform_key};
use super::state::{
    auto_check_effective, LatestSeen, PendingRestart, SeenAsset, StateFile, StateStore,
};
use super::version::{parse, pick_latest, update_available};
use crate::update::install::cancel::CancelToken;

type SharedEnv = Arc<dyn DetectEnv + Send + Sync>;

/// Background re-check interval (3 days).
const DEFAULT_CHECK_INTERVAL: Duration = Duration::from_secs(3 * 24 * 3600);
/// Delay before the first background check after boot, so boot stays quiet.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
/// Minimum gap between two real fetches, even when forced. Mirrored by
/// `FORCE_FLOOR_MS` in `UpdateSetting.tsx` (checked by `tests/update_ui_mirrors.rs`).
pub const FORCE_FLOOR: Duration = Duration::from_secs(30);
/// Per-request timeout of the GitHub client.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
/// The background loop wakes at least this often (system sleep, clock changes).
const BACKGROUND_WAKE: Duration = Duration::from_secs(3600);

/// Construction parameters for [`UpdateService`].
pub struct UpdateConfig {
    pub vst_home: PathBuf,
    pub current_version: String,
    pub boot_exe: PathBuf,
    pub boot_id: String,
    pub api_base: String,
    /// `None` in the CLI fallback and in tests that do not observe events.
    pub broadcaster: Option<Broadcaster>,
    /// Re-check interval for background checks (3 days).
    pub check_interval: Duration,
    /// Delay before the first background check after boot (60 s).
    pub first_check_delay: Duration,
    /// Minimum gap between two real fetches, even when forced (30 s).
    pub force_floor: Duration,
}

impl UpdateConfig {
    /// Production defaults (3 d / 60 s / 30 s, public GitHub API).
    pub fn with_defaults(
        vst_home: PathBuf,
        current_version: String,
        boot_exe: PathBuf,
        boot_id: String,
        broadcaster: Option<Broadcaster>,
    ) -> Self {
        UpdateConfig {
            vst_home,
            current_version,
            boot_exe,
            boot_id,
            api_base: api_base_from_env(),
            broadcaster,
            check_interval: DEFAULT_CHECK_INTERVAL,
            first_check_delay: FIRST_CHECK_DELAY,
            force_floor: FORCE_FLOOR,
        }
    }
}

/// `VST_UPDATE_API_BASE` or the default GitHub API base.
pub fn api_base_from_env() -> String {
    std::env::var("VST_UPDATE_API_BASE")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_API_BASE.to_string())
}

/// Which `ServerEvent` a mutation publishes. Every mutation publishes the WHOLE snapshot; clients replace, never merge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PublishKind {
    Available,
    Progress,
    Installed,
    Changed,
}

struct Detected {
    method: InstallMethod,
    targets: Vec<UpdateTarget>,
}

/// In-memory install state (never persisted; lost on restart by design).
#[derive(Default)]
struct Runtime {
    install: Option<InstallProgress>,
    last_result: Option<InstallResult>,
    cancel: Option<Arc<CancelToken>>,
}

pub struct UpdateService {
    current_version: String,
    boot_exe: PathBuf,
    boot_id: String,
    api_base: String,
    broadcaster: Option<Broadcaster>,
    check_interval: Duration,
    first_check_delay: Duration,
    force_floor: Duration,
    hosted_by_tauri: bool,
    restarting: AtomicBool,
    restart_notify: Arc<tokio::sync::Notify>,
    /// The one environment seam: env vars plus the filesystem/process probes install
    /// detection uses. `RealEnv` in production; a hermetic stub in tests.
    env: SharedEnv,
    client: reqwest::Client,
    store: StateStore,
    state: Mutex<StateFile>,
    detected: Mutex<Detected>,
    /// Test hook: pins the detection result so `redetect` cannot clobber it.
    #[cfg(any(test, feature = "test-seams"))]
    detect_override: Mutex<Option<Detected>>,
    /// Test hook: replaces the compiled-in release keys (tests cannot sign
    /// with the pinned production key). Always `None` in production.
    #[cfg(any(test, feature = "test-seams"))]
    pub(super) trusted_keys_override:
        Mutex<Option<Vec<crate::update::install::signature::PinnedKey>>>,
    /// Lock order: `state` -> `detected` -> `rt`.
    rt: Mutex<Runtime>,
    /// Version last announced via `update:available` (dedupe).
    announced: Mutex<Option<String>>,
    /// When the last real fetch was attempted (30 s floor).
    last_attempt: Mutex<Option<Instant>>,
    /// Serialises concurrent checks.
    check_gate: tokio::sync::Mutex<()>,
    /// The pending restart last probed with `--version` and when, so the
    /// 500 ms CLI poll does not fork a process every tick.
    pub(super) last_pending_probe: Mutex<Option<(PendingRestart, Instant)>>,
}

/// Due when never checked, unparseable, in the future, or older than
/// `interval`.
pub(crate) fn is_due(last_checked: Option<&str>, now: DateTime<Utc>, interval: Duration) -> bool {
    let Some(raw) = last_checked else {
        return true;
    };
    let Ok(t) = DateTime::parse_from_rfc3339(raw) else {
        return true;
    };
    let t = t.with_timezone(&Utc);
    if t > now {
        return true;
    }
    match (now - t).to_std() {
        Ok(age) => age >= interval,
        Err(_) => true,
    }
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

impl UpdateService {
    /// Load state from `<vst_home>/update-state.json` and run `detect` once.
    pub fn new(cfg: UpdateConfig) -> Arc<Self> {
        Self::build(cfg, Arc::new(RealEnv))
    }

    /// Test constructor: unreachable API base, auto-check forced off via the
    /// env hook (so `autoCheck` reports false), no broadcaster. Hermetic: install
    /// detection runs against a stub environment, never the real `$HOME`. Tests
    /// that need a mock GitHub or a broadcaster use [`UpdateService::new`] with
    /// their own [`UpdateConfig`].
    #[cfg(any(test, feature = "test-seams"))]
    pub fn for_tests(vst_home: &Path) -> Arc<Self> {
        let cfg = UpdateConfig {
            vst_home: vst_home.to_path_buf(),
            current_version: "0.0.1".to_string(),
            boot_exe: std::env::current_exe().unwrap_or_default(),
            boot_id: "test-boot-id".to_string(),
            api_base: "http://127.0.0.1:9".to_string(),
            broadcaster: None,
            check_interval: DEFAULT_CHECK_INTERVAL,
            first_check_delay: FIRST_CHECK_DELAY,
            force_floor: FORCE_FLOOR,
        };
        Self::with_env_for_tests(cfg, |k| (k == "VST_UPDATE_CHECK").then(|| "0".to_string()))
    }

    /// Test constructor with an injected (hermetic) environment lookup.
    #[cfg(any(test, feature = "test-seams"))]
    pub fn with_env_for_tests(
        cfg: UpdateConfig,
        env: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Self::build(cfg, Arc::new(super::detect::StubEnv::new(env)))
    }

    fn build(cfg: UpdateConfig, env: SharedEnv) -> Arc<Self> {
        let (store, state) = StateStore::load_or_default(super::paths::update_state(&cfg.vst_home));
        let mut state = state;
        if let Some(p) = &state.pending_restart {
            // A restart is pending only while the running version is older than the
            // installed one: here the running version caught up with the pending one.
            if let (Some(c), Some(v)) = (parse(&cfg.current_version), parse(&p.version)) {
                if c >= v {
                    state.pending_restart = None;
                    if let Err(e) = store.save(&state) {
                        tracing::warn!(err = %e, "failed to persist update state");
                    }
                }
            }
        }
        let (method, targets) = detect(&cfg.boot_exe, &*env);

        // One reliable signal: the desktop app always exports
        // `VST_HOSTED_BY=tauri`; otherwise only the RUNNING binary's own
        // classification (`method` describes the boot exe alone) counts.
        // `VST_CLOUDFLARED_BIN` leaks into every child shell and is a user
        // override, so it is never evidence of a desktop host.
        let hosted_by_tauri = env.var("VST_HOSTED_BY").as_deref() == Some("tauri")
            || matches!(
                method,
                InstallMethod::Dmg
                    | InstallMethod::Deb
                    | InstallMethod::AppImage
                    | InstallMethod::CurlAppImage
            );

        let client = crate::update::http::timeout_client(HTTP_TIMEOUT);
        Arc::new(UpdateService {
            current_version: cfg.current_version,
            boot_exe: cfg.boot_exe,
            boot_id: cfg.boot_id,
            api_base: cfg.api_base,
            broadcaster: cfg.broadcaster,
            check_interval: cfg.check_interval,
            first_check_delay: cfg.first_check_delay,
            force_floor: cfg.force_floor,
            hosted_by_tauri,
            restarting: AtomicBool::new(false),
            restart_notify: Arc::new(tokio::sync::Notify::new()),
            env,
            client,
            store,
            state: Mutex::new(state),
            detected: Mutex::new(Detected { method, targets }),
            #[cfg(any(test, feature = "test-seams"))]
            detect_override: Mutex::new(None),
            #[cfg(any(test, feature = "test-seams"))]
            trusted_keys_override: Mutex::new(None),
            rt: Mutex::new(Runtime::default()),
            announced: Mutex::new(None),
            last_attempt: Mutex::new(None),
            check_gate: tokio::sync::Mutex::new(()),
            last_pending_probe: Mutex::new(None),
        })
    }

    pub fn boot_id(&self) -> &str {
        &self.boot_id
    }

    pub fn is_hosted_by_tauri(&self) -> bool {
        self.hosted_by_tauri
    }

    pub fn is_restarting(&self) -> bool {
        self.restarting.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Trigger a daemon restart (atomic transition false -> true).
    ///
    /// Mutually exclusive with an install: the `rt` guard is held across
    /// the install check and the CAS, and `start_install` checks
    /// `is_restarting` under the same guard, so neither can slip in between.
    pub fn begin_restart(&self) -> Result<(), UpdateApiErrorCode> {
        use std::sync::atomic::Ordering;
        let rt = self.rt.lock().unwrap();
        if rt.install.is_some() {
            return Err(UpdateApiErrorCode::UpdateInProgress);
        }
        let cas = self
            .restarting
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst);
        drop(rt);
        if cas.is_err() {
            return Err(UpdateApiErrorCode::RestartInProgress);
        }

        if let Some(b) = &self.broadcaster {
            b.send(ServerEvent::DaemonRestarting);
        }
        self.restart_notify.notify_one();
        Ok(())
    }

    pub fn restart_signal(&self) -> Arc<tokio::sync::Notify> {
        self.restart_notify.clone()
    }

    /// The current snapshot, built from persisted state + cached detection.
    pub fn snapshot(&self) -> UpdateStatus {
        let state = self.state.lock().unwrap();
        let det = self.detected.lock().unwrap();
        self.build_snapshot(&state, &det)
    }

    fn build_snapshot(&self, s: &StateFile, det: &Detected) -> UpdateStatus {
        let latest = s.latest_seen.as_ref();
        let latest_version = latest.map(|l| l.version.clone());
        let available = latest_version
            .as_deref()
            .map(|l| {
                if let Some(rb) = &s.rolled_back {
                    if rb.failed_version == l {
                        return false;
                    }
                }
                update_available(&self.current_version, l)
            })
            .unwrap_or(false);
        let key = platform_key();
        let pa = assets_for(key);
        let wanted: Vec<&str> = [pa.cli, pa.appimage, pa.deb, pa.dmg]
            .into_iter()
            .flatten()
            .collect();
        let no_asset = available
            && latest
                .map(|l| !l.assets.iter().any(|a| wanted.contains(&a.name.as_str())))
                .unwrap_or(false);
        // Single guard: locking `rt` twice inside the literal would deadlock.
        let (rt_install, rt_result) = {
            let rt = self.rt.lock().unwrap();
            (rt.install.clone(), rt.last_result.clone())
        };
        UpdateStatus {
            current: self.current_version.clone(),
            latest: latest_version,
            changelog: latest.and_then(|l| l.body.clone()),
            release_url: latest.map(|l| l.html_url.clone()),
            behind_count: latest.map(|l| l.behind_count).unwrap_or(0),
            update_available: available,
            skipped: s.skipped_versions.clone(),
            install_method: det.method.clone(),
            targets: det.targets.clone(),
            checked_at: s.last_checked.clone(),
            last_error: s.last_error.clone(),
            auto_check: auto_check_effective(s, &|k| self.env.var(k)),
            install: rt_install,
            restart_pending: s
                .pending_restart
                .as_ref()
                .filter(|p| self.pending_is_live(p))
                .map(|p| RestartPending {
                    version: p.version.clone(),
                    kind: p.kind,
                }),
            rolled_back: s.rolled_back.clone(),
            last_result: rt_result,
            platform: key.to_string(),
            no_asset,
        }
    }

    fn persist(&self, s: &StateFile) {
        if let Err(e) = self.store.save(s) {
            tracing::warn!(err = %e, "failed to persist update state");
        }
    }

    /// Re-run install-method detection off the async runtime.
    async fn redetect(self: &Arc<Self>) {
        let boot_exe = self.boot_exe.clone();
        let env = self.env.clone();
        let res = tokio::task::spawn_blocking(move || detect(&boot_exe, &*env)).await;
        if let Ok((method, targets)) = res {
            #[cfg(any(test, feature = "test-seams"))]
            if let Some(d) = &*self.detect_override.lock().unwrap() {
                *self.detected.lock().unwrap() = Detected {
                    method: d.method.clone(),
                    targets: d.targets.clone(),
                };
                return;
            }
            *self.detected.lock().unwrap() = Detected { method, targets };
        }
    }

    /// Check GitHub for a newer release.
    ///
    /// Only `force == true` (a manual check) ever contacts GitHub from here.
    /// A non-forced call is the page-load / CLI-poll path: it returns the
    /// cached snapshot and never fetches, so `autoCheck`, `VST_UPDATE_CHECK=0`
    /// and the boot delay cannot be bypassed by opening a tab. The
    /// due-driven fetch lives in [`UpdateService::run_background`], which
    /// applies those gates. Forced checks within the floor of the previous
    /// fetch return the cached snapshot. Errors are recorded in
    /// `lastError`, never returned.
    pub async fn check(self: &Arc<Self>, force: bool) -> UpdateStatus {
        if !force {
            let _gate = self.check_gate.lock().await;
            self.refresh_pending_restart().await;
            return self.snapshot();
        }
        self.check_inner(true).await
    }

    /// The fetching check. `force == false` is the background timer (due-gated).
    async fn check_inner(self: &Arc<Self>, force: bool) -> UpdateStatus {
        let _gate = self.check_gate.lock().await;
        self.refresh_pending_restart().await;
        if !force {
            let due = {
                let s = self.state.lock().unwrap();
                is_due(s.last_checked.as_deref(), Utc::now(), self.check_interval)
            };
            if !due {
                return self.snapshot();
            }
        }
        {
            let la = self.last_attempt.lock().unwrap();
            if let Some(t) = *la {
                if t.elapsed() < self.force_floor {
                    drop(la);
                    return self.snapshot();
                }
            }
        }
        *self.last_attempt.lock().unwrap() = Some(Instant::now());
        self.redetect().await;

        let etag = self.state.lock().unwrap().etag.clone();
        let outcome = fetch_releases(&self.client, &self.api_base, etag.as_deref()).await;
        let kind = {
            let mut s = self.state.lock().unwrap();
            match outcome {
                FetchOutcome::Fresh { releases, etag } => {
                    s.last_checked = Some(now_rfc3339());
                    s.last_error = None;
                    s.etag = etag;
                    let candidate = pick_latest(&releases, &self.current_version);
                    if let Some(ref c) = candidate {
                        if let Some(ref rb) = s.rolled_back {
                            if let (Some(cand_v), Some(fail_v)) =
                                (parse(&c.version), parse(&rb.failed_version))
                            {
                                if cand_v > fail_v {
                                    s.rolled_back = None;
                                }
                            }
                        }
                    }
                    s.latest_seen = candidate.map(|c| LatestSeen {
                        version: c.version,
                        tag: c.release.tag_name.clone(),
                        body: c.release.body.clone(),
                        html_url: c.release.html_url.clone(),
                        behind_count: c.behind_count,
                        assets: c
                            .release
                            .assets
                            .iter()
                            .map(|a| SeenAsset {
                                name: a.name.clone(),
                                url: a.browser_download_url.clone(),
                                size: a.size,
                            })
                            .collect(),
                    });
                }
                FetchOutcome::NotModified => {
                    s.last_checked = Some(now_rfc3339());
                    s.last_error = None;
                }
                FetchOutcome::RateLimited { retry_after } => {
                    s.last_error = Some(UpdateError {
                        kind: UpdateErrorKind::Check,
                        reason: UpdateReason::RateLimited,
                        message: "GitHub rate limit reached; try again later.".to_string(),
                        retry_after,
                    });
                }
                FetchOutcome::Offline => {
                    s.last_error = Some(UpdateError {
                        kind: UpdateErrorKind::Check,
                        reason: UpdateReason::Offline,
                        message: "Could not reach GitHub.".to_string(),
                        retry_after: None,
                    });
                }
                FetchOutcome::GithubError(msg) => {
                    s.last_error = Some(UpdateError {
                        kind: UpdateErrorKind::Check,
                        reason: UpdateReason::GithubError,
                        message: msg,
                        retry_after: None,
                    });
                }
            }
            self.persist(&s);
            self.publish_kind_for(&s)
        };
        let snap = self.snapshot();
        self.publish(kind, &snap);
        snap
    }

    /// `Available` only when the actionable version differs from the last
    /// announced one; otherwise `Changed`.
    fn publish_kind_for(&self, s: &StateFile) -> PublishKind {
        let det = self.detected.lock().unwrap();
        let snap = self.build_snapshot(s, &det);
        let mut announced = self.announced.lock().unwrap();
        match (&snap.latest, snap.update_available) {
            (Some(v), true) if !snap.skipped.contains(v) => {
                if announced.as_deref() == Some(v.as_str()) {
                    PublishKind::Changed
                } else {
                    *announced = Some(v.clone());
                    PublishKind::Available
                }
            }
            _ => PublishKind::Changed,
        }
    }

    /// Persist the auto-check preference (never affected by the env override).
    pub async fn set_auto_check(self: &Arc<Self>, on: bool) -> UpdateStatus {
        {
            let mut s = self.state.lock().unwrap();
            s.auto_check = on;
            self.persist(&s);
        }
        let snap = self.snapshot();
        self.publish(PublishKind::Changed, &snap);
        snap
    }

    /// Background loop: after `first_check_delay`, check whenever auto-check is
    /// on and a check is due; wakes at least hourly.
    pub async fn run_background(self: Arc<Self>) {
        tokio::time::sleep(self.first_check_delay).await;
        loop {
            let run = {
                let s = self.state.lock().unwrap();
                auto_check_effective(&s, &|k| self.env.var(k))
                    && is_due(s.last_checked.as_deref(), Utc::now(), self.check_interval)
            };
            if run {
                self.check_inner(false).await;
            }
            tokio::time::sleep(BACKGROUND_WAKE.min(self.check_interval)).await;
        }
    }

    pub(crate) fn publish(&self, kind: PublishKind, status: &UpdateStatus) {
        let Some(b) = &self.broadcaster else { return };
        let status = status.clone();
        b.send(match kind {
            PublishKind::Available => ServerEvent::UpdateAvailable { status },
            PublishKind::Progress => ServerEvent::UpdateProgress { status },
            PublishKind::Installed => ServerEvent::UpdateInstalled { status },
            PublishKind::Changed => ServerEvent::UpdateChanged { status },
        });
    }
}

mod ops;

#[cfg(test)]
mod tests;
