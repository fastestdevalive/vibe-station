//! Install, cancel, skip/unskip and restart-pending logic of [`UpdateService`]
//! A child module of `service` so it can reach the private
//! fields; split out to keep `service.rs` well under the file-size cap.

use std::fs::File;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use vst_types::rest::update::UpdateApiErrorCode;
use vst_types::rest::update::{
    InstallProgress, InstallResult, InstallStage, StartedBy, UpdateError, UpdateErrorKind,
    UpdateReason, UpdateStatus,
};

use super::{PublishKind, UpdateService};
use crate::lock::LockWait;
use crate::update::detect::{DetectEnv, RealEnv};
use crate::update::install::cancel::CancelToken;
use crate::update::install::{run_install, InstallCtx, InstallOutcome};
use crate::update::paths;
use crate::update::state::{PendingRestart, RestartKind};
use crate::update::version::{parse, update_available};

/// Install progress is published on a stage change, or when it advanced by at
/// least this many percent AND this long has passed (keeps the WS quiet).
const PROGRESS_MIN_STEP_PCT: u8 = 5;
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(250);

/// Minimum gap between `<exe> --version` probes of the same pending restart.
const PENDING_PROBE_INTERVAL: Duration = Duration::from_secs(30);

fn install_error(reason: UpdateReason, message: &str) -> UpdateError {
    UpdateError {
        kind: UpdateErrorKind::Install,
        reason,
        message: message.to_string(),
        retry_after: None,
    }
}

fn busy() -> UpdateError {
    install_error(
        UpdateReason::UpdateInProgress,
        "An update is already running.",
    )
}

impl UpdateService {
    /// The pending restart only counts while the running version is
    /// older than the version that was installed.
    pub(super) fn pending_is_live(&self, p: &PendingRestart) -> bool {
        matches!(
            (parse(&self.current_version), parse(&p.version)),
            (Some(c), Some(v)) if c < v
        )
    }

    /// Drop `pendingRestart` once `<exePath> --version` no longer reports
    /// the pending version (daemon-kind only: running an AppImage with
    /// `--version` would launch the app). A missing executable also clears it.
    pub(super) async fn refresh_pending_restart(self: &Arc<Self>) {
        let Some(p) = self.state.lock().unwrap().pending_restart.clone() else {
            return;
        };
        if p.kind != RestartKind::Daemon {
            return;
        }
        {
            let mut last = self.last_pending_probe.lock().unwrap();
            match &*last {
                Some((lp, at)) if *lp == p && at.elapsed() < PENDING_PROBE_INTERVAL => return,
                _ => *last = Some((p.clone(), Instant::now())),
            }
        }
        let exe = PathBuf::from(&p.exe_path);
        let probe = tokio::task::spawn_blocking(move || {
            let exists = exe.exists();
            (RealEnv.run(&exe, &["--version"]), exists)
        })
        .await;
        let Ok((out, exists)) = probe else { return };
        let still_reports = out
            .as_deref()
            .and_then(|l| l.split_whitespace().last())
            .map(|v| v.trim_start_matches('v') == p.version)
            .unwrap_or(false);
        // A failed run of an existing exe is inconclusive: keep the banner.
        let clear = match out {
            Some(_) => !still_reports,
            None => !exists,
        };
        if clear {
            let mut s = self.state.lock().unwrap();
            if s.pending_restart.as_ref() == Some(&p) {
                s.pending_restart = None;
                self.persist(&s);
            }
        }
    }

    /// Take `<vst_home>/.update.lock` non-blockingly.
    fn take_update_lock(&self) -> Result<File, UpdateError> {
        match paths::try_update_lock(self.store.dir(), LockWait::NONE) {
            Ok(Some(f)) => Ok(f),
            Ok(None) => Err(busy()),
            Err(e) => Err(install_error(UpdateReason::WriteFailed, &e.to_string())),
        }
    }

    fn install_ctx(&self) -> Result<InstallCtx, UpdateError> {
        let s = self.state.lock().unwrap();
        let det = self.detected.lock().unwrap();
        let latest = s
            .latest_seen
            .as_ref()
            .filter(|l| update_available(&self.current_version, &l.version));
        let Some(latest) = latest else {
            return Err(install_error(
                UpdateReason::NoAsset,
                "No update is available to install.",
            ));
        };
        Ok(InstallCtx {
            vst_home: self.store.dir().to_path_buf(),
            latest: latest.version.clone(),
            current: self.current_version.clone(),
            trusted_keys: self.trusted_keys(),
            assets: latest.assets.clone(),
            targets: det.targets.clone(),
            boot_exe: self.boot_exe.clone(),
            appimage_env: self
                .env
                .var("APPIMAGE")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            keep_prev: s
                .pending_restart
                .as_ref()
                .is_some_and(|p| self.pending_is_live(p)),
        })
    }

    /// Start an install in the background and return the first snapshot.
    ///
    /// `Err(update_in_progress)` when an install (this process or a CLI
    /// fallback holding `.update.lock`) is already running; any other `Err`
    /// means nothing to install.
    pub fn start_install(self: &Arc<Self>, by: StartedBy) -> Result<UpdateStatus, UpdateError> {
        self.install_ctx()?; // fail fast: nothing to install
        let cancel = Arc::new(CancelToken::new());
        let lock = {
            let mut rt = self.rt.lock().unwrap();
            if rt.install.is_some() {
                return Err(busy());
            }
            // Install and restart are mutually exclusive: `begin_restart` takes
            // this same `rt` guard around its CAS, so an install can't start once a restart has been accepted.
            if self.is_restarting() {
                return Err(install_error(
                    UpdateReason::UpdateInProgress,
                    "The daemon is restarting; try again once it is back.",
                ));
            }
            let lock = self.take_update_lock()?;
            rt.install = Some(InstallProgress {
                stage: InstallStage::Preflight,
                pct: 0,
                started_by: by.clone(),
            });
            rt.last_result = None;
            rt.cancel = Some(cancel.clone());
            lock
        };
        {
            let mut s = self.state.lock().unwrap();
            s.last_error = None;
            s.rolled_back = None;
            self.persist(&s);
        }
        let snap = self.snapshot();
        self.publish(PublishKind::Progress, &snap);
        let this = self.clone();
        tokio::spawn(async move { this.drive_install(by, cancel, lock).await });
        Ok(snap)
    }

    async fn drive_install(self: Arc<Self>, by: StartedBy, cancel: Arc<CancelToken>, lock: File) {
        self.redetect().await;
        let result = match self.install_ctx() {
            Ok(ctx) => {
                let this = self.clone();
                // (last stage, last pct, last publish time)
                let last = Mutex::new((None::<InstallStage>, 0u8, Instant::now()));
                let cb = move |stage: InstallStage, pct: u8| {
                    let publish = {
                        let mut l = last.lock().unwrap();
                        let changed = l.0.as_ref() != Some(&stage);
                        let due = pct >= l.1.saturating_add(PROGRESS_MIN_STEP_PCT)
                            && l.2.elapsed() >= PROGRESS_MIN_INTERVAL;
                        if changed || due {
                            *l = (Some(stage.clone()), pct, Instant::now());
                        }
                        changed || due
                    };
                    if publish {
                        this.rt.lock().unwrap().install = Some(InstallProgress {
                            stage,
                            pct,
                            started_by: by.clone(),
                        });
                        let snap = this.snapshot();
                        this.publish(PublishKind::Progress, &snap);
                    }
                };
                run_install(ctx, &cb, cancel).await
            }
            Err(e) => Err(e),
        };
        drop(lock);
        self.finish_install(result).await;
    }

    /// Persist the outcome of an install and publish it (shared by the
    /// background task and [`UpdateService::install_foreground`]).
    async fn finish_install(self: &Arc<Self>, result: Result<InstallOutcome, UpdateError>) {
        match result {
            Ok(outcome) => {
                {
                    let mut s = self.state.lock().unwrap();
                    s.last_error = None;
                    s.rolled_back = None;
                    if outcome.pending_restart.is_some() {
                        s.pending_restart = outcome.pending_restart;
                    }
                    self.persist(&s);
                }
                {
                    let mut rt = self.rt.lock().unwrap();
                    rt.last_result = Some(outcome.result);
                    rt.install = None;
                    rt.cancel = None;
                }
                self.redetect().await;
                let snap = self.snapshot();
                self.publish(PublishKind::Installed, &snap);
            }
            Err(e) => {
                {
                    let mut s = self.state.lock().unwrap();
                    // A cancel clears the error instead of setting one.
                    s.last_error = (e.reason != UpdateReason::Cancelled).then_some(e);
                    self.persist(&s);
                }
                {
                    let mut rt = self.rt.lock().unwrap();
                    rt.install = None;
                    rt.cancel = None;
                }
                let snap = self.snapshot();
                self.publish(PublishKind::Progress, &snap);
            }
        }
    }

    /// Run an install in the calling task, reporting through `progress` (the
    /// daemon-less CLI path). The CALLER must hold `.update.lock`
    /// (one writer at a time) -- this never takes it. Persists `lastResult` /
    /// `pendingRestart` exactly like the daemon path.
    pub async fn install_foreground(
        self: &Arc<Self>,
        progress: &(dyn Fn(InstallStage, u8) + Send + Sync),
        cancel: Arc<CancelToken>,
    ) -> Result<InstallResult, UpdateError> {
        self.redetect().await;
        let ctx = self.install_ctx()?;
        let res = run_install(ctx, progress, cancel).await;
        self.finish_install(res.clone()).await;
        res.map(|o| o.result)
    }

    /// Request cancellation. Only possible while downloading.
    pub fn cancel(&self) -> Result<UpdateStatus, UpdateApiErrorCode> {
        {
            let rt = self.rt.lock().unwrap();
            let downloading = rt
                .install
                .as_ref()
                .is_some_and(|i| i.stage == InstallStage::Downloading);
            match (&rt.cancel, downloading) {
                (Some(token), true) => token.cancel(),
                _ => return Err(UpdateApiErrorCode::NotCancellable),
            }
        }
        Ok(self.snapshot())
    }

    /// Hide `v` (no `v` prefix) from the chip; a skip also clears a rollback.
    pub async fn skip(&self, v: &str) -> UpdateStatus {
        {
            let mut s = self.state.lock().unwrap();
            if !s.skipped_versions.iter().any(|x| x == v) {
                s.skipped_versions.push(v.to_string());
            }
            s.rolled_back = None;
            self.persist(&s);
        }
        let snap = self.snapshot();
        self.publish(PublishKind::Changed, &snap);
        snap
    }

    pub async fn unskip(&self, v: &str) -> UpdateStatus {
        {
            let mut s = self.state.lock().unwrap();
            s.skipped_versions.retain(|x| x != v);
            self.persist(&s);
        }
        let snap = self.snapshot();
        self.publish(PublishKind::Changed, &snap);
        snap
    }

    /// The release keys to verify against: the compiled-in set, or (test seam) an override.
    fn trusted_keys(&self) -> Vec<crate::update::install::signature::PinnedKey> {
        #[cfg(any(test, feature = "test-seams"))]
        if let Some(k) = self.trusted_keys_override.lock().unwrap().clone() {
            return k;
        }
        crate::update::install::signature::pinned_keys()
    }

    /// Test hook: trust `keys` instead of the compiled-in release keys.
    #[cfg(any(test, feature = "test-seams"))]
    pub fn set_trusted_keys_for_tests(
        &self,
        keys: Vec<crate::update::install::signature::PinnedKey>,
    ) {
        *self.trusted_keys_override.lock().unwrap() = Some(keys);
    }

    /// Test hook: pin install-method detection (scripts fail the ELF check).
    #[cfg(any(test, feature = "test-seams"))]
    pub fn set_detected_for_tests(
        &self,
        method: vst_types::rest::update::InstallMethod,
        targets: Vec<vst_types::rest::update::UpdateTarget>,
    ) {
        let pinned = || super::Detected {
            method: method.clone(),
            targets: targets.clone(),
        };
        *self.detected.lock().unwrap() = pinned();
        *self.detect_override.lock().unwrap() = Some(pinned());
    }
}
