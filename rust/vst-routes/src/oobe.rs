//! `OobeRoutes` — out-of-the-box onboarding (OOBE) state, step confirmation,
//! starter-bundle orchestration, and completion.
//!
//! Owns `~/.vibe-station/oobe.json` (guarded by a per-process `write_lock`,
//! mirroring `SettingsRoutes`'s config.json shape). Phase 2 of the
//! `oobe-onboarding` plan.

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use vst_git::paths::Paths;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::oobe::{
    CompleteOobeResult, ConfirmStep1Result, ConfirmStep2Result, DetectAndBundleResult,
    OobeStateResponse,
};
use vst_types::rest::settings::PatchSettingsBody;
use vst_types::rest::shared::Mode;
use vst_types::CliId;

use crate::fs::expand_tilde;
use crate::modes::{BundleOutcome, ModeRoutes};
use crate::settings::SettingsRoutes;

/// Errors surfaced by the OOBE route handlers. `ValidationError` maps to 400,
/// `NoModeForDetectedCli` maps to 409.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OobeRouteError {
    #[error("{0}")]
    ValidationError(String),
    #[error("no mode exists for any detected CLI")]
    NoModeForDetectedCli,
}

/// The on-disk shape of `oobe.json`.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct PersistedOobe {
    completed: bool,
    step1_confirmed: bool,
    /// Whether step 2 (agent mode setup) has been confirmed. `#[serde(default)]`
    /// on the struct makes a pre-existing `oobe.json` that predates this field
    /// (no `step2_confirmed` key) still deserialize to `false` instead of
    /// failing and falling back to `PersistedOobe::default()` — which would
    /// otherwise re-gate existing users by resetting `completed` to `false`.
    step2_confirmed: bool,
    /// CLIs whose starter bundle has already been auto-created once via the
    /// automatic (non-explicit) trigger — R12a. Starts empty; never seeded
    /// from pre-existing modes (see `seed_default`).
    auto_bundle_created_for: Vec<CliId>,
}

/// Handler for `/oobe/*`.
#[derive(Clone)]
pub struct OobeRoutes {
    mode_routes: ModeRoutes,
    settings_routes: SettingsRoutes,
    broadcaster: Broadcaster,
    paths: Paths,
    // Serializes read-modify-write of oobe.json across clones (Axum clones the
    // handler state per request). Shared via the Arc, same as SettingsRoutes.
    write_lock: Arc<Mutex<()>>,
}

impl OobeRoutes {
    pub fn new(
        mode_routes: ModeRoutes,
        settings_routes: SettingsRoutes,
        broadcaster: Broadcaster,
        paths: Paths,
    ) -> Self {
        Self {
            mode_routes,
            settings_routes,
            broadcaster,
            paths,
            write_lock: Arc::new(Mutex::new(())),
        }
    }

    fn oobe_path(&self) -> PathBuf {
        self.paths.vst_home().join("oobe.json")
    }

    async fn file_exists(&self) -> bool {
        tokio::fs::try_exists(&self.oobe_path())
            .await
            .unwrap_or(false)
    }

    /// Read `oobe.json`; a missing or unparseable file yields the default
    /// (all-false) state, never an error.
    async fn read_raw(&self) -> PersistedOobe {
        let p = self.oobe_path();
        match tokio::fs::read_to_string(&p).await {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => PersistedOobe::default(),
        }
    }

    /// Persist `oobe.json` (best-effort; callers hold `write_lock`).
    async fn write(&self, persisted: &PersistedOobe) {
        let p = self.oobe_path();
        if let Some(parent) = p.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Ok(json) = serde_json::to_string_pretty(persisted) {
            let _ = tokio::fs::write(&p, json).await;
        }
    }

    /// First-ever read of `oobe.json`: OOBE always starts at step 1,
    /// not completed — regardless of any pre-existing projects or modes.
    /// A daemon that already has projects/modes (e.g. seeded demo data, or an
    /// upgrade from a pre-OOBE version) is NOT auto-marked complete; the user
    /// still walks through both steps, and any pre-existing modes simply show
    /// up naturally in step 2's list (and in `detect-and-bundle`'s results as
    /// already-satisfied bundle entries), rather than the daemon guessing on
    /// their behalf whether onboarding "already happened".
    async fn seed_default(&self) -> PersistedOobe {
        // Double-checked: `get_state`'s `file_exists()` check runs OUTSIDE
        // this lock, so a concurrent caller could have already written real
        // state (e.g. `confirm_step1`) between that check and this call
        // acquiring the lock. Re-check under the lock and return the
        // already-written state instead of blindly overwriting it with
        // defaults.
        let _guard = self.write_lock.lock().await;
        if self.file_exists().await {
            return self.read_raw().await;
        }
        let persisted = PersistedOobe::default();
        self.write(&persisted).await;
        persisted
    }

    /// `GET /oobe/state`
    pub async fn get_state(&self) -> OobeStateResponse {
        let persisted = if self.file_exists().await {
            self.read_raw().await
        } else {
            self.seed_default().await
        };
        let current_step = if !persisted.step1_confirmed {
            1
        } else if !persisted.step2_confirmed {
            2
        } else {
            3
        };
        let default_projects_dir = self
            .settings_routes
            .get_settings()
            .await
            .default_projects_dir
            .unwrap_or_default();
        OobeStateResponse {
            completed: persisted.completed,
            current_step,
            default_projects_dir,
            vst_home: self.paths.vst_home().to_string_lossy().to_string(),
        }
    }

    /// `POST /oobe/step1` — confirm the projects directory.
    pub async fn confirm_step1(&self, dir: String) -> Result<ConfirmStep1Result, OobeRouteError> {
        let resolved = expand_tilde(&dir);
        if !resolved.is_absolute() {
            return Err(OobeRouteError::ValidationError(
                "path must be absolute".into(),
            ));
        }

        // R9 "unwritable" case. `create_dir_all` alone is not sufficient: it
        // succeeds as a no-op when `resolved` already exists, regardless of
        // whether the caller can actually write to it (e.g. a user pointing
        // this at `/usr` or another directory they don't own) — so also probe
        // writability by creating and removing a marker file.
        tokio::fs::create_dir_all(&resolved)
            .await
            .map_err(|_| OobeRouteError::ValidationError("path is not writable".into()))?;
        let probe = resolved.join(".vibe-station-write-check");
        tokio::fs::write(&probe, b"")
            .await
            .map_err(|_| OobeRouteError::ValidationError("path is not writable".into()))?;
        let _ = tokio::fs::remove_file(&probe).await;

        let resolved_str = resolved.to_string_lossy().to_string();

        self.settings_routes
            .patch_settings(PatchSettingsBody {
                default_projects_dir: Some(resolved_str.clone()),
                skill_paths: None,
                theme_id: None,
                markdown_style: None,
                reset_markdown_style: None,
                search_case_sensitive: None,
                search_regex: None,
                search_whole_word: None,
                last_mode_id: None,
                default_channel_by_cli: None,
            })
            .await
            .map_err(|_| OobeRouteError::ValidationError("path is not writable".into()))?;

        let _guard = self.write_lock.lock().await;
        let mut persisted = self.read_raw().await;
        persisted.step1_confirmed = true;
        self.write(&persisted).await;

        Ok(ConfirmStep1Result {
            ok: true,
            default_projects_dir: resolved_str,
        })
    }

    /// `POST /oobe/step2` — confirm step 2 (agent mode setup) is done, advancing
    /// `currentStep` to 3. No request body — step 2's own state (which modes
    /// exist) already persisted via `/api/modes` as each mode was created.
    pub async fn confirm_step2(&self) -> ConfirmStep2Result {
        let _guard = self.write_lock.lock().await;
        let mut persisted = self.read_raw().await;
        persisted.step2_confirmed = true;
        self.write(&persisted).await;
        ConfirmStep2Result { ok: true }
    }

    /// `POST /oobe/detect-and-bundle`
    pub async fn detect_and_bundle(&self) -> DetectAndBundleResult {
        let mut supported_clis = self.mode_routes.list_supported_clis().await;
        let mut created: Vec<Mode> = vec![];
        // Read-only snapshot, just to decide which CLIs still need a bundle
        // attempt this call — NOT what gets written back (see below).
        let snapshot = self.read_raw().await;
        let mut newly_satisfied: Vec<CliId> = vec![];
        let mut models_errors = std::collections::BTreeMap::new();

        for entry in &supported_clis {
            if entry.detected && !snapshot.auto_bundle_created_for.contains(&entry.id) {
                let outcome: BundleOutcome = self.mode_routes.ensure_starter_bundle(entry.id).await;
                created.extend(outcome.created);
                if let Some(err) = outcome.models_error {
                    models_errors.insert(entry.id, err);
                }
                if outcome.primary_satisfied {
                    newly_satisfied.push(entry.id);
                }
            }
        }

        // Re-read fresh state UNDER the lock and merge only the marker
        // additions this call computed, rather than writing back the whole
        // `snapshot` taken before the (slow, network-bound) bundle loop above.
        // Writing back a stale snapshot wholesale would silently undo a
        // `complete()`/`confirm_step1()` that landed on `oobe.json` while this
        // call's bundle loop was still in flight (e.g. a concurrent tab
        // finishing OOBE, or React StrictMode's double-invoked mount effect
        // racing this same call against itself).
        if !newly_satisfied.is_empty() {
            let _guard = self.write_lock.lock().await;
            let mut fresh = self.read_raw().await;
            for cli in newly_satisfied {
                if !fresh.auto_bundle_created_for.contains(&cli) {
                    fresh.auto_bundle_created_for.push(cli);
                }
            }
            self.write(&fresh).await;
        }

        // Re-fetch so `usingFallbackOnly`/`starterBundleNames` reflect the modes
        // just created.
        supported_clis = self.mode_routes.list_supported_clis().await;

        DetectAndBundleResult {
            supported_clis,
            created,
            models_errors,
        }
    }

    /// `POST /oobe/complete` — re-verify R19 server-side, then mark complete.
    pub async fn complete(&self) -> Result<CompleteOobeResult, OobeRouteError> {
        let modes = self.mode_routes.list_modes().await;
        let supported = self.mode_routes.list_supported_clis().await;
        let satisfied = modes
            .iter()
            .any(|m| supported.iter().any(|s| s.detected && s.id == m.cli));
        if !satisfied {
            return Err(OobeRouteError::NoModeForDetectedCli);
        }

        let _guard = self.write_lock.lock().await;
        let mut persisted = self.read_raw().await;
        persisted.completed = true;
        self.write(&persisted).await;
        drop(_guard);

        self.broadcaster
            .send(ServerEvent::OobeStateUpdated { completed: true });

        Ok(CompleteOobeResult {
            ok: true,
            completed: true,
        })
    }
}
