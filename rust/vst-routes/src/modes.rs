//! `routes/modes.ts` — CRUD for agent modes + supported CLIs + model resolution.
//!
//! Stored in `~/.vibe-station/modes.json` (max 20 modes).
//!
//! Ports `daemon/src/routes/modes.ts` (314 LOC) into Rust:
//! - `GET /supported-clis` (list supported CLIs with defaults and capabilities)
//! - `GET /cli-models?cli=` (fetch models for a CLI via plugin with 10m caching)
//! - `GET /modes` (load all modes from file/cache)
//! - `POST /modes` (create mode, validation, name conflict check, max 20 limit, broadcast)
//! - `PUT /modes/:id` (update mode, patch semantics, CLI change model invalidation, broadcast)
//! - `DELETE /modes/:id` (delete mode, count affected active sessions, broadcast)
//!
//! Plus the existing read/resolve helpers: `load_modes`, `resolve_mode_id`,
//! `json_unsupported_cli`, and `find_mode`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};

use vst_agents::home::home_dir;
use vst_agents::native_history_importer::has_native_history_importer;
use vst_agents::registry::{resolve_plugin, SUPPORTED_CLIS};
use vst_git::paths::Paths;
use vst_store::StoreHandle;
use vst_types::domain::LifecycleState;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::modes::{
    CliModels, CreateModeBody, DeleteModeResult, SupportedCli, UpdateModeBody,
};
use vst_types::rest::shared::Mode;
use vst_types::CliId;

pub const MAX_MODES: usize = 20;
pub const MAX_CONTEXT_LEN: usize = 10_000;
pub const MAX_MODEL_LEN: usize = 100;
/// Icon keys the web-ui ships an asset for; an explicit `icon` must be one of these.
pub const KNOWN_MODE_ICONS: [&str; 5] = ["claude", "agy", "cursor", "opencode", "deepseek"];

fn validate_icon(icon: &str) -> Result<String, ModeRouteError> {
    let icon = icon.trim();
    if KNOWN_MODE_ICONS.contains(&icon) {
        Ok(icon.to_string())
    } else {
        Err(ModeRouteError::Validation(format!(
            "Unknown icon '{icon}'. Expected one of: {}.",
            KNOWN_MODE_ICONS.join(", ")
        )))
    }
}
pub const CLI_MODEL_CACHE_TTL: Duration = Duration::from_secs(10 * 60);

/// Load all modes from `~/.vibe-station/modes.json`. Returns an empty vec on
/// any error (file missing, unparseable) — mirrors the TS `loadModes` catch.
pub fn load_modes() -> Vec<Mode> {
    let path = home_dir().join(".vibe-station").join("modes.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let modes = serde_json::from_str::<Vec<Mode>>(&text).unwrap_or_default();
            derive_missing_icons(modes)
        }
        Err(_) => vec![],
    }
}

/// Fill in `icon` for any mode missing it (legacy rows), deriving from the
/// mode's CLI + model via the plugin. In-memory only — persistence happens on
/// the next `save_modes`, not on the read path.
pub(crate) fn derive_missing_icons(modes: Vec<Mode>) -> Vec<Mode> {
    modes
        .into_iter()
        .map(|m| {
            if m.icon.is_some() {
                m
            } else {
                let icon = resolve_plugin(m.cli)
                    .default_mode_icon(m.model.as_deref())
                    .to_string();
                Mode {
                    icon: Some(icon),
                    ..m
                }
            }
        })
        .collect()
}

/// Resolve a `modeId` that may be either an `id` or a `name` to the canonical
/// mode `id`. Mirrors the TS `resolveModeId`; returns `None` when no match.
pub fn resolve_mode_id(input: &str) -> Option<String> {
    let modes = load_modes();
    if let Some(m) = modes.iter().find(|m| m.id == input) {
        return Some(m.id.clone());
    }
    if let Some(m) = modes.iter().find(|m| m.name == input) {
        return Some(m.id.clone());
    }
    None
}

/// Create-time JSON-capability gate: given a resolved `modeId`, return the
/// mode's CLI id when that CLI's plugin does NOT support the JSON channel
/// (so the caller can reject with 400), or `None` when it's supported or the
/// mode is missing. Mirrors the TS `jsonUnsupportedCli`.
pub fn json_unsupported_cli(mode_id: &str) -> Option<CliId> {
    let modes = load_modes();
    let mode = modes.iter().find(|m| m.id == mode_id)?;
    let plugin = resolve_plugin(mode.cli);
    if plugin.supports_json() {
        None
    } else {
        Some(mode.cli)
    }
}

/// Find a mode by canonical id.
pub fn find_mode(mode_id: &str) -> Option<Mode> {
    load_modes().into_iter().find(|m| m.id == mode_id)
}

/// Errors surfaced by mode route handlers.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ModeRouteError {
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Conflict: {message}")]
    Conflict {
        message: String,
        conflict_with: Option<String>,
    },
    #[error("Mode '{0}' not found")]
    NotFound(String),
    #[error("Internal server error: {0}")]
    Internal(String),
}

impl ModeRouteError {
    pub fn validation(msg: impl Into<String>) -> Self {
        Self::Validation(msg.into())
    }

    pub fn conflict(msg: impl Into<String>, conflict_with: Option<String>) -> Self {
        Self::Conflict {
            message: msg.into(),
            conflict_with,
        }
    }
}

fn normalize_model_field(model: Option<&str>) -> Option<String> {
    model
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(ToString::to_string)
}

fn generate_mode_id() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let rand_part = format!("{:05x}", rand_u32() % 0x100000);
    format!("mode-{ms}-{rand_part}")
}

fn rand_u32() -> u32 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    std::time::Instant::now().hash(&mut hasher);
    std::thread::current().id().hash(&mut hasher);
    (hasher.finish() & 0xFFFFFFFF) as u32
}

struct CliModelCacheEntry {
    models: Vec<String>,
    fetched_at: Instant,
}

/// ModeRoutes handle providing full CRUD and resolution for modes.
#[derive(Clone)]
pub struct ModeRoutes {
    pub store: StoreHandle,
    pub broadcaster: Broadcaster,
    pub paths: Paths,
    modes_file: Option<PathBuf>,
    modes_cache: Arc<RwLock<Option<Vec<Mode>>>>,
    cli_model_cache: Arc<RwLock<HashMap<CliId, CliModelCacheEntry>>>,
    cli_model_inflight: Arc<Mutex<HashMap<CliId, Arc<Mutex<()>>>>>,
}

impl ModeRoutes {
    pub fn new(store: StoreHandle, broadcaster: Broadcaster) -> Self {
        Self {
            store,
            broadcaster,
            paths: Paths::default(),
            modes_file: None,
            modes_cache: Arc::new(RwLock::new(None)),
            cli_model_cache: Arc::new(RwLock::new(HashMap::new())),
            cli_model_inflight: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Set an explicit modes.json file path (test seam).
    pub fn with_modes_file(mut self, path: PathBuf) -> Self {
        self.modes_file = Some(path);
        self
    }

    pub fn with_paths(mut self, paths: Paths) -> Self {
        self.paths = paths;
        self
    }

    fn file_path(&self) -> PathBuf {
        if let Some(ref path) = self.modes_file {
            path.clone()
        } else {
            self.paths.vst_home().join("modes.json")
        }
    }

    /// Load modes with in-memory caching and fallback to disk.
    pub async fn load_modes(&self) -> Vec<Mode> {
        {
            let cache = self.modes_cache.read().await;
            if let Some(ref modes) = *cache {
                return modes.clone();
            }
        }

        let path = self.file_path();
        let loaded = match tokio::fs::read_to_string(&path).await {
            Ok(content) => {
                let modes = serde_json::from_str::<Vec<Mode>>(&content).unwrap_or_default();
                derive_missing_icons(modes)
            }
            Err(_) => vec![],
        };

        let mut cache = self.modes_cache.write().await;
        *cache = Some(loaded.clone());
        loaded
    }

    async fn save_modes(&self, modes: &[Mode]) -> Result<(), ModeRouteError> {
        let path = self.file_path();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ModeRouteError::Internal(e.to_string()))?;
        }

        let json = serde_json::to_string_pretty(modes)
            .map_err(|e| ModeRouteError::Internal(e.to_string()))?;

        tokio::fs::write(&path, json)
            .await
            .map_err(|e| ModeRouteError::Internal(e.to_string()))?;

        let mut cache = self.modes_cache.write().await;
        *cache = Some(modes.to_vec());
        Ok(())
    }

    pub async fn reset_cache_for_test(&self) {
        let mut cache = self.modes_cache.write().await;
        *cache = None;
    }

    // ── 1. GET /supported-clis ─────────────────────────────────────────────
    pub fn list_supported_clis(&self) -> Vec<SupportedCli> {
        SUPPORTED_CLIS
            .iter()
            .map(|&cli| {
                let plugin = resolve_plugin(cli);
                let default_model = plugin.default_model().to_string();
                let supports_json = plugin.supports_json();
                let cli_name = match cli {
                    CliId::Claude => "claude",
                    CliId::Cursor => "cursor",
                    CliId::Opencode => "opencode",
                    CliId::Agy => "agy",
                };
                let imports_native_history = has_native_history_importer(cli_name);
                let supports_json_to_terminal_resume = plugin.supports_json_to_terminal_resume();

                SupportedCli {
                    id: cli,
                    default_model,
                    supports_json,
                    imports_native_history,
                    supports_json_to_terminal_resume,
                }
            })
            .collect()
    }

    // ── 2. GET /cli-models?cli= ───────────────────────────────────────────
    pub async fn resolve_cli_models(&self, cli: CliId) -> CliModels {
        // 1. Check TTL cache
        {
            let cache = self.cli_model_cache.read().await;
            if let Some(entry) = cache.get(&cli) {
                if entry.fetched_at.elapsed() < CLI_MODEL_CACHE_TTL {
                    return CliModels {
                        models: entry.models.clone(),
                        error: None,
                    };
                }
            }
        }

        // 2. In-flight deduplication
        let inflight_lock = {
            let mut map = self.cli_model_inflight.lock().await;
            map.entry(cli)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };

        let _guard = inflight_lock.lock().await;

        // Re-check cache after acquiring lock
        {
            let cache = self.cli_model_cache.read().await;
            if let Some(entry) = cache.get(&cli) {
                if entry.fetched_at.elapsed() < CLI_MODEL_CACHE_TTL {
                    return CliModels {
                        models: entry.models.clone(),
                        error: None,
                    };
                }
            }
        }

        let plugin = resolve_plugin(cli);
        let result = plugin.list_models().await;

        let res = if let Some(ref err) = result.error {
            CliModels {
                models: result.models,
                error: Some(err.clone()),
            }
        } else {
            let models = result.models;
            let mut cache = self.cli_model_cache.write().await;
            cache.insert(
                cli,
                CliModelCacheEntry {
                    models: models.clone(),
                    fetched_at: Instant::now(),
                },
            );
            CliModels {
                models,
                error: None,
            }
        };

        // Clean up inflight entry
        {
            let mut map = self.cli_model_inflight.lock().await;
            map.remove(&cli);
        }

        res
    }

    // ── 3. GET /modes ─────────────────────────────────────────────────────
    pub async fn list_modes(&self) -> Vec<Mode> {
        self.load_modes().await
    }

    // ── 4. POST /modes ────────────────────────────────────────────────────
    pub async fn create_mode(&self, body: CreateModeBody) -> Result<Mode, ModeRouteError> {
        let name = body.name.trim();
        if name.is_empty() || name.len() > 64 {
            return Err(ModeRouteError::validation(
                "Mode name must be between 1 and 64 characters.",
            ));
        }

        let context = body.context.trim();
        if context.is_empty() || context.len() > MAX_CONTEXT_LEN {
            return Err(ModeRouteError::validation(format!(
                "Mode context must be between 1 and {MAX_CONTEXT_LEN} characters."
            )));
        }

        if let Some(ref m) = body.model {
            if m.len() > MAX_MODEL_LEN {
                return Err(ModeRouteError::validation(format!(
                    "Model identifier must not exceed {MAX_MODEL_LEN} characters."
                )));
            }
        }

        let model_norm = normalize_model_field(body.model.as_deref());

        let modes = self.load_modes().await;
        if modes.len() >= MAX_MODES {
            return Err(ModeRouteError::validation(format!(
                "Maximum {MAX_MODES} modes allowed"
            )));
        }

        if modes.iter().any(|m| m.name == name) {
            return Err(ModeRouteError::conflict(
                format!("A mode named '{name}' already exists."),
                Some(name.to_string()),
            ));
        }

        let now_iso = format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );

        // Explicit icon wins; otherwise derive from the CLI + model (Decision 1).
        let icon = match body.icon.as_deref() {
            Some(icon) => validate_icon(icon)?,
            None => resolve_plugin(body.cli)
                .default_mode_icon(model_norm.as_deref())
                .to_string(),
        };

        let mode = Mode {
            id: generate_mode_id(),
            name: name.to_string(),
            cli: body.cli,
            context: context.to_string(),
            created_at: now_iso,
            model: model_norm,
            icon: Some(icon),
        };

        let mut updated = modes;
        updated.push(mode.clone());
        self.save_modes(&updated).await?;

        if let Ok(val) = serde_json::to_value(&mode) {
            if let Some(map) = val.as_object() {
                self.broadcaster
                    .send(ServerEvent::ModeCreated { mode: map.clone() });
            }
        }

        Ok(mode)
    }

    // ── 5. PUT /modes/:id ─────────────────────────────────────────────────
    pub async fn update_mode(
        &self,
        id: &str,
        body: UpdateModeBody,
    ) -> Result<Mode, ModeRouteError> {
        if let Some(ref name) = body.name {
            let trimmed = name.trim();
            if trimmed.is_empty() || trimmed.len() > 64 {
                return Err(ModeRouteError::validation(
                    "Mode name must be between 1 and 64 characters.",
                ));
            }
        }

        if let Some(ref context) = body.context {
            let trimmed = context.trim();
            if trimmed.is_empty() || trimmed.len() > MAX_CONTEXT_LEN {
                return Err(ModeRouteError::validation(format!(
                    "Mode context must be between 1 and {MAX_CONTEXT_LEN} characters."
                )));
            }
        }

        if let Some(ref m) = body.model {
            if m.len() > MAX_MODEL_LEN {
                return Err(ModeRouteError::validation(format!(
                    "Model identifier must not exceed {MAX_MODEL_LEN} characters."
                )));
            }
        }

        let mut modes = self.load_modes().await;
        let idx = modes
            .iter()
            .position(|m| m.id == id)
            .ok_or_else(|| ModeRouteError::NotFound(id.to_string()))?;

        if let Some(ref name) = body.name {
            let trimmed = name.trim();
            if modes
                .iter()
                .enumerate()
                .any(|(i, m)| i != idx && m.name == trimmed)
            {
                return Err(ModeRouteError::conflict(
                    format!("A mode named '{trimmed}' already exists."),
                    Some(trimmed.to_string()),
                ));
            }
        }

        let prev = &modes[idx];
        let mut updated = prev.clone();

        let mut cli_changed = false;
        let mut model_changed = false;
        if let Some(ref name) = body.name {
            updated.name = name.trim().to_string();
        }
        if let Some(ref context) = body.context {
            updated.context = context.trim().to_string();
        }
        if let Some(cli) = body.cli {
            cli_changed = cli != prev.cli;
            updated.cli = cli;
            // Changing CLI invalidates the saved model unless caller explicitly supplies a new one
            if body.model.is_none() {
                updated.model = None;
            }
        }
        if let Some(ref model) = body.model {
            let m = normalize_model_field(Some(model.as_str()));
            model_changed = updated.model != m;
            updated.model = m;
        }

        // Explicit icon wins; otherwise re-derive on cli/model change (Decision 1).
        if let Some(ref icon) = body.icon {
            updated.icon = Some(validate_icon(icon)?);
        } else if cli_changed || model_changed {
            updated.icon = Some(
                resolve_plugin(updated.cli)
                    .default_mode_icon(updated.model.as_deref())
                    .to_string(),
            );
        }

        modes[idx] = updated.clone();
        self.save_modes(&modes).await?;

        if let Ok(val) = serde_json::to_value(&updated) {
            if let Some(map) = val.as_object() {
                self.broadcaster
                    .send(ServerEvent::ModeUpdated { mode: map.clone() });
            }
        }

        Ok(updated)
    }

    // ── 6. DELETE /modes/:id ──────────────────────────────────────────────
    pub async fn delete_mode(&self, id: &str) -> Result<DeleteModeResult, ModeRouteError> {
        let modes = self.load_modes().await;
        if !modes.iter().any(|m| m.id == id) {
            return Err(ModeRouteError::NotFound(id.to_string()));
        }

        let affected_sessions = self.count_sessions_using_mode(id).await;

        let filtered: Vec<Mode> = modes.into_iter().filter(|m| m.id != id).collect();
        self.save_modes(&filtered).await?;

        self.broadcaster.send(ServerEvent::ModeDeleted {
            mode_id: id.to_string(),
        });

        Ok(DeleteModeResult {
            ok: true,
            affected_sessions,
        })
    }

    async fn count_sessions_using_mode(&self, mode_id: &str) -> i64 {
        let is_active = |state: LifecycleState| {
            state != LifecycleState::Done && state != LifecycleState::Exited
        };

        let mut count = 0i64;
        let projects = self.store.get_all_projects().await;
        for project in projects {
            for wt in &project.worktrees {
                for session in &wt.sessions {
                    if session.mode_id.as_deref() == Some(mode_id)
                        && is_active(session.lifecycle.state)
                    {
                        count += 1;
                    }
                }
            }
            for session in &project.direct_sessions {
                if session.mode_id.as_deref() == Some(mode_id) && is_active(session.lifecycle.state)
                {
                    count += 1;
                }
            }
        }
        count
    }
}
