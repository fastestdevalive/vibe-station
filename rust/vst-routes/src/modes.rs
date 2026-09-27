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

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};

use vst_agents::home::home_dir;
use vst_agents::native_history_importer::has_native_history_importer;
use vst_agents::plugin::AgentPlugin;
use vst_agents::registry::{check_binary, resolve_plugin, SUPPORTED_CLIS};
use vst_git::paths::Paths;
use vst_store::StoreHandle;
use vst_types::domain::{Channel, LifecycleState};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::modes::{
    CliModels, CreateModeBody, DeleteModeResult, SupportedCli, UpdateModeBody,
};
use vst_types::rest::shared::Mode;
use vst_types::CliId;

use crate::settings::load_default_channel_overrides;

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

/// Resolve a `modeId`/`modeName` to the full canonicalized `Mode` in a single
/// `load_modes()` call — replaces the separate `resolve_mode_id` + `find_mode`
/// two-call sequence wherever a caller needs both the canonical id AND the
/// resolved `Mode` (e.g. computing a channel default off `mode.cli`).
/// TWO-PASS (id over the whole list, then name), matching `resolve_mode_id`'s
/// exact semantics — a mode whose *name* collides with another mode's *id*
/// resolves identically here and in `resolve_mode_id`.
pub fn resolve_mode(input: &str) -> Option<Mode> {
    let modes = load_modes();
    modes
        .iter()
        .find(|m| m.id == input)
        .or_else(|| modes.iter().find(|m| m.name == input))
        .cloned()
}

/// Resolve a CLI's **effective** default channel: a persisted user override
/// (if present and still valid) else the plugin's own hardwired
/// `default_channel()`. Pure and TOTAL — never returns a worse result than
/// "no override": a persisted `Json` override for a CLI whose plugin doesn't
/// (or no longer) `supports_json()`, or a stray `Pty`, silently falls back to
/// the plugin default instead of 400ing every default-path create. Every
/// default-channel consumer (session/worktree create, draft-start, inheritance
/// fallback, `list_supported_clis`) calls into this — none re-derives the
/// override-vs-plugin fallback.
pub fn resolve_effective_default_channel(
    overrides: &BTreeMap<CliId, Channel>,
    cli: CliId,
    plugin: &dyn AgentPlugin,
) -> Channel {
    match overrides.get(&cli).copied() {
        Some(Channel::Json) if !plugin.supports_json() => plugin.default_channel(),
        Some(ch @ (Channel::Tmux | Channel::Json)) => ch,
        _ => plugin.default_channel(), // None, or a stray Pty
    }
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
    /// Serializes `create_mode`'s check-then-write (name-uniqueness check +
    /// `save_modes`) across concurrent callers. Without this, two concurrent
    /// `create_mode` calls for different names can both pass the
    /// `load_modes()` snapshot check before either writes, so the second
    /// `save_modes` (last-write-wins over the whole file) silently discards
    /// the first mode even though its caller already got back `Ok`. This is
    /// exercised for real by `ensure_starter_bundle` (OOBE's
    /// `detect-and-bundle` fans out over every detected CLI) combined with
    /// React StrictMode's double-invoked effects in dev.
    create_mode_lock: Arc<Mutex<()>>,
    /// Resolve a CLI to its [`AgentPlugin`] — test seam (default `resolve_plugin`).
    plugin_resolver: fn(CliId) -> Box<dyn AgentPlugin>,
    /// Check whether a binary exists on PATH — test seam (default `check_binary`).
    binary_checker: fn(&str) -> bool,
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
            create_mode_lock: Arc::new(Mutex::new(())),
            plugin_resolver: resolve_plugin,
            binary_checker: check_binary,
        }
    }

    /// Set an explicit modes.json file path (test seam).
    pub fn with_modes_file(mut self, path: PathBuf) -> Self {
        self.modes_file = Some(path);
        self
    }

    /// Override the plugin resolver (test seam).
    pub fn with_plugin_resolver(mut self, f: fn(CliId) -> Box<dyn AgentPlugin>) -> Self {
        self.plugin_resolver = f;
        self
    }

    /// Override the binary checker (test seam).
    pub fn with_binary_checker(mut self, f: fn(&str) -> bool) -> Self {
        self.binary_checker = f;
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
    pub async fn list_supported_clis(&self) -> Vec<SupportedCli> {
        let modes = self.load_modes().await;
        // Hoisted out of the per-CLI map (round-3 n3): a single config.json
        // read/parse for all 4 CLIs, not one per CLI.
        let overrides = load_default_channel_overrides();
        SUPPORTED_CLIS
            .iter()
            .map(|&cli| {
                let plugin = (self.plugin_resolver)(cli);
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
                let default_channel = resolve_effective_default_channel(&overrides, cli, &*plugin);
                // round-3 M1: "overridden" means the EFFECTIVE value differs from
                // the plugin's own default — not merely "a key exists for this
                // CLI". A redundant override (set to the same value the plugin
                // already defaults to) or a stale override the resolver had to
                // drop (e.g. Json on a plugin that no longer supports_json())
                // must both report `false`, or the UI mislabels which option is
                // "(default)" and a user's channel pick can silently bounce back.
                let default_channel_overridden = default_channel != plugin.default_channel();

                let detected = (self.binary_checker)(plugin.binary_name());
                let starter_bundle_names: Vec<String> = plugin
                    .starter_bundle()
                    .iter()
                    .map(|e| e.name.clone())
                    .collect();
                let has_named_entry = |n: &str| modes.iter().any(|m| m.cli == cli && m.name == n);
                let using_fallback_only = starter_bundle_names.len() > 1
                    && !starter_bundle_names.iter().any(|n| has_named_entry(n))
                    && has_named_entry(&format!("{}-default", plugin.name()));

                SupportedCli {
                    id: cli,
                    default_model,
                    supports_json,
                    imports_native_history,
                    supports_json_to_terminal_resume,
                    detected,
                    starter_bundle_names,
                    using_fallback_only,
                    default_channel,
                    default_channel_overridden,
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

        let plugin = (self.plugin_resolver)(cli);
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

        // Held across the whole check-then-write below (load_modes' snapshot,
        // the length/name checks, and the final save_modes) — see the lock's
        // own doc comment for why an unguarded version of this is racy.
        let _create_guard = self.create_mode_lock.lock().await;

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
            None => (self.plugin_resolver)(body.cli)
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
                (self.plugin_resolver)(updated.cli)
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

    /// Ensure this CLI's starter mode bundle exists, creating any missing
    /// modes. In-process return value consumed by `OobeRoutes`/route handlers
    /// (which map it into the wire `DetectAndBundleResult`/`StarterBundleResult`).
    pub async fn ensure_starter_bundle(&self, cli: CliId) -> BundleOutcome {
        let plugin = (self.plugin_resolver)(cli);
        let entries = plugin.starter_bundle();
        let mut created = vec![];
        let mut already_present = vec![];
        let mut skipped = vec![];
        let has_named_entries = entries.iter().any(|e| e.model_name.is_some());
        let existing_modes = self.load_modes().await;

        for entry in &entries {
            // An existing mode with this bundle name is ALWAYS "satisfied" —
            // check this BEFORE attempting any discovery lookup or create_mode
            // call, so a pre-existing mode never depends on discovery succeeding
            // again.
            if let Some(existing) = existing_modes
                .iter()
                .find(|m| m.cli == cli && m.name == entry.name)
            {
                already_present.push(existing.clone());
                continue;
            }

            let model = match &entry.model_name {
                None => plugin.default_model().to_string(),
                Some(name) => {
                    let models = self.resolve_cli_models(cli).await; // TTL-cached
                    if models.models.iter().any(|m| m == name) {
                        name.clone()
                    } else {
                        skipped.push(entry.name.clone()); // R13b: skip only this one
                        continue;
                    }
                }
            };
            match self
                .create_mode(CreateModeBody {
                    name: entry.name.clone(),
                    cli,
                    context: entry.context.clone(),
                    preset_id: None,
                    model: Some(model),
                    icon: None,
                })
                .await
            {
                Ok(mode) => created.push(mode),
                // A conflict here has two distinct causes that must be told
                // apart — `create_mode`'s name check is global, not
                // per-CLI (see its own `modes.iter().any(|m| m.name == name)`):
                // (1) a concurrent caller created THIS bundle entry (same cli +
                // name) between our snapshot and this call — genuinely
                // "already present", never a failure; (2) the name is taken by
                // a mode under a DIFFERENT cli (e.g. a user-created "opus-planner"
                // under cursor) — this entry can never be created under that
                // name, so it must land in `skipped`, not be silently dropped
                // (dropping it would leave "Recreate" permanently unable to
                // report progress on this entry with no explanation).
                Err(ModeRouteError::Conflict { .. }) => {
                    match self
                        .load_modes()
                        .await
                        .into_iter()
                        .find(|m| m.name == entry.name)
                    {
                        Some(m) if m.cli == cli => already_present.push(m),
                        _ => skipped.push(entry.name.clone()),
                    }
                }
                Err(_) => skipped.push(entry.name.clone()),
            }
        }

        // R13c: fallback fires ONLY when truly nothing named exists yet — not
        // when an explicit "Recreate" is called on an already-complete bundle.
        let nothing_named_exists =
            has_named_entries && created.is_empty() && already_present.is_empty();
        let used_fallback = nothing_named_exists;
        if used_fallback {
            let fallback_name = format!("{}-default", plugin.name());
            // R13c-iii: reuse the existing fallback mode by name instead of
            // duplicating it.
            if let Some(existing) = existing_modes
                .iter()
                .find(|m| m.cli == cli && m.name == fallback_name)
            {
                already_present.push(existing.clone());
            } else if let Ok(mode) = self
                .create_mode(CreateModeBody {
                    name: fallback_name,
                    cli,
                    context: "You are a helpful coding assistant.".into(),
                    preset_id: None,
                    model: Some(plugin.default_model().to_string()),
                    icon: None,
                })
                .await
            {
                created.push(mode);
            }
        }

        // R13c-i: the "primary satisfied" marker only counts real named entries
        // (new or pre-existing), never the fallback mode.
        let primary_satisfied =
            !used_fallback && (!created.is_empty() || !already_present.is_empty());
        BundleOutcome {
            created,
            already_present,
            skipped,
            used_fallback,
            primary_satisfied,
        }
    }
}

/// Result of [`ModeRoutes::ensure_starter_bundle`] — a plain in-process return
/// value (NOT a wire type). The route handlers map it into the wire
/// `DetectAndBundleResult`/`StarterBundleResult` shapes.
pub struct BundleOutcome {
    pub created: Vec<Mode>,
    pub already_present: Vec<Mode>,
    pub skipped: Vec<String>,
    pub used_fallback: bool,
    pub primary_satisfied: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tempfile::tempdir;
    use vst_agents::claude::create_claude_plugin;
    use vst_agents::plugin::{
        AsyncResult, ComposePromptInput, ComposePromptResult, LaunchConfig, ListModelsResult,
        PromptDelivery, ReadySignal, StarterBundleEntry,
    };

    /// A real claude bundle's 3 named starter entries, shared by the test-only
    /// plugins below so 2.T2/2.T3 exercise the same curated shape.
    fn claude_like_bundle() -> Vec<StarterBundleEntry> {
        vec![
            StarterBundleEntry {
                name: "sonnet-implementer".to_string(),
                model_name: Some("sonnet".to_string()),
                context: "c".to_string(),
            },
            StarterBundleEntry {
                name: "opus-planner".to_string(),
                model_name: Some("opus".to_string()),
                context: "c".to_string(),
            },
            StarterBundleEntry {
                name: "fable-security-reviewer".to_string(),
                model_name: Some("fable".to_string()),
                context: "c".to_string(),
            },
        ]
    }

    /// Minimal required-method stub for the test-only plugins.
    macro_rules! stub_plugin_base {
        () => {
            fn name(&self) -> &str {
                "claude"
            }
            fn default_model(&self) -> &str {
                "sonnet"
            }
            fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
                "claude"
            }
            fn prompt_delivery(&self) -> PromptDelivery {
                PromptDelivery::Inline
            }
            fn get_launch_command(&self, _cfg: &LaunchConfig) -> Vec<String> {
                vec![]
            }
            fn get_environment(&self, _cfg: &LaunchConfig) -> BTreeMap<String, String> {
                BTreeMap::new()
            }
            fn get_ready_signal(&self) -> ReadySignal {
                ReadySignal {
                    sentinel: None,
                    fallback_ms: 0,
                }
            }
            fn compose_launch_prompt(&self, _input: ComposePromptInput) -> ComposePromptResult {
                ComposePromptResult::default()
            }
            fn default_channel(&self) -> vst_types::domain::Channel {
                vst_types::domain::Channel::Json
            }
        };
    }

    struct FailingModelsPlugin;

    impl AgentPlugin for FailingModelsPlugin {
        stub_plugin_base!();
        fn list_models(&self) -> AsyncResult<ListModelsResult> {
            Box::pin(async {
                ListModelsResult {
                    models: vec![],
                    error: Some("offline".into()),
                }
            })
        }
        fn starter_bundle(&self) -> Vec<StarterBundleEntry> {
            claude_like_bundle()
        }
    }

    struct PartialModelsPlugin;

    impl AgentPlugin for PartialModelsPlugin {
        stub_plugin_base!();
        fn list_models(&self) -> AsyncResult<ListModelsResult> {
            Box::pin(async {
                ListModelsResult {
                    models: vec!["sonnet".into()],
                    error: None,
                }
            })
        }
        fn starter_bundle(&self) -> Vec<StarterBundleEntry> {
            claude_like_bundle()
        }
    }

    fn empty_routes() -> ModeRoutes {
        let dir = tempdir().unwrap();
        let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
        ModeRoutes::new(store, Broadcaster::new(16))
            .with_modes_file(dir.path().join("modes.json"))
            .with_plugin_resolver(|_| Box::new(create_claude_plugin()))
    }

    #[tokio::test]
    async fn test_ensure_starter_bundle_empty_creates_all() {
        let routes = empty_routes();
        let out = routes.ensure_starter_bundle(CliId::Claude).await;
        assert_eq!(out.created.len(), 3);
        assert!(out.already_present.is_empty());
        assert!(!out.used_fallback);
        assert!(out.primary_satisfied);
    }

    #[tokio::test]
    async fn test_ensure_starter_bundle_models_offline_falls_back() {
        let routes = empty_routes().with_plugin_resolver(|_| Box::new(FailingModelsPlugin));
        let out = routes.ensure_starter_bundle(CliId::Claude).await;
        assert_eq!(
            out.created
                .iter()
                .map(|m| m.name.as_str())
                .collect::<Vec<_>>(),
            vec!["claude-default"]
        );
        assert!(out.already_present.is_empty());
        assert!(out.used_fallback);
        assert!(!out.primary_satisfied);
    }

    #[tokio::test]
    async fn test_ensure_starter_bundle_partial_models_skips_missing() {
        let routes = empty_routes().with_plugin_resolver(|_| Box::new(PartialModelsPlugin));
        let out = routes.ensure_starter_bundle(CliId::Claude).await;
        assert_eq!(out.created.len(), 1);
        assert_eq!(out.created[0].name, "sonnet-implementer");
        assert_eq!(
            out.skipped,
            vec![
                "opus-planner".to_string(),
                "fable-security-reviewer".to_string()
            ]
        );
        assert!(out.already_present.is_empty());
        assert!(!out.used_fallback);
    }

    #[tokio::test]
    async fn test_ensure_starter_bundle_partial_preexisting_satisfied() {
        let routes = empty_routes();
        routes
            .create_mode(CreateModeBody {
                name: "sonnet-implementer".to_string(),
                cli: CliId::Claude,
                context: "c".to_string(),
                preset_id: None,
                model: Some("sonnet".to_string()),
                icon: None,
            })
            .await
            .unwrap();
        routes
            .create_mode(CreateModeBody {
                name: "opus-planner".to_string(),
                cli: CliId::Claude,
                context: "c".to_string(),
                preset_id: None,
                model: Some("opus".to_string()),
                icon: None,
            })
            .await
            .unwrap();
        let out = routes.ensure_starter_bundle(CliId::Claude).await;
        assert_eq!(out.already_present.len(), 2);
        assert_eq!(out.created.len(), 1);
        assert_eq!(out.created[0].name, "fable-security-reviewer");
        assert!(!out.used_fallback);
        assert!(out.primary_satisfied);
    }

    #[tokio::test]
    async fn test_ensure_starter_bundle_complete_no_spurious_fallback() {
        let routes = empty_routes();
        for name in [
            "sonnet-implementer",
            "opus-planner",
            "fable-security-reviewer",
        ] {
            routes
                .create_mode(CreateModeBody {
                    name: name.to_string(),
                    cli: CliId::Claude,
                    context: "c".to_string(),
                    preset_id: None,
                    model: Some("x".to_string()),
                    icon: None,
                })
                .await
                .unwrap();
        }
        let out = routes.ensure_starter_bundle(CliId::Claude).await;
        assert!(out.created.is_empty());
        assert_eq!(out.already_present.len(), 3);
        assert!(!out.used_fallback);
        assert!(out.primary_satisfied);
    }

    #[tokio::test]
    async fn test_ensure_starter_bundle_cross_cli_name_conflict_is_skipped_not_dropped() {
        // A mode named "opus-planner" already exists, but under CURSOR, not
        // claude. create_mode's name check is global, so claude's attempt to
        // create its own "opus-planner" entry conflicts — this must land in
        // `skipped` (a real, permanent gap the caller can see), never be
        // silently swallowed by both `created` and `already_present`.
        let routes = empty_routes();
        routes
            .create_mode(CreateModeBody {
                name: "opus-planner".to_string(),
                cli: CliId::Cursor,
                context: "c".to_string(),
                preset_id: None,
                model: Some("auto".to_string()),
                icon: None,
            })
            .await
            .unwrap();

        let out = routes.ensure_starter_bundle(CliId::Claude).await;
        assert_eq!(out.skipped, vec!["opus-planner".to_string()]);
        assert!(out.already_present.iter().all(|m| m.name != "opus-planner"));
        assert!(out.created.iter().all(|m| m.name != "opus-planner"));
        // The other 2 entries are unaffected.
        assert_eq!(out.created.len(), 2);
    }

    #[tokio::test]
    async fn test_create_mode_concurrent_calls_never_lose_a_mode() {
        // Regression for the create_mode_lock: two concurrent create_mode
        // calls with DIFFERENT names must both survive — without the lock,
        // both could pass the load_modes() snapshot check before either
        // writes, and the second (last-write-wins) save_modes call would
        // silently discard the first mode despite it having returned Ok.
        let routes = empty_routes();
        let a = {
            let routes = routes.clone();
            tokio::spawn(async move {
                routes
                    .create_mode(CreateModeBody {
                        name: "concurrent-a".to_string(),
                        cli: CliId::Claude,
                        context: "c".to_string(),
                        preset_id: None,
                        model: Some("sonnet".to_string()),
                        icon: None,
                    })
                    .await
            })
        };
        let b = {
            let routes = routes.clone();
            tokio::spawn(async move {
                routes
                    .create_mode(CreateModeBody {
                        name: "concurrent-b".to_string(),
                        cli: CliId::Claude,
                        context: "c".to_string(),
                        preset_id: None,
                        model: Some("sonnet".to_string()),
                        icon: None,
                    })
                    .await
            })
        };
        let (a, b) = tokio::join!(a, b);
        a.unwrap().expect("mode a should be created");
        b.unwrap().expect("mode b should be created");

        let names: Vec<String> = routes
            .load_modes()
            .await
            .into_iter()
            .map(|m| m.name)
            .collect();
        assert!(names.contains(&"concurrent-a".to_string()));
        assert!(names.contains(&"concurrent-b".to_string()));
    }

    /// A plugin that defaults to `Tmux` and does NOT `supports_json()` — only
    /// this 2.T11 test stub has that combination (no real `CliId` does), which
    /// is exactly why the stub is needed to exercise the total-ness branch.
    struct TmuxNoJsonStub;
    impl AgentPlugin for TmuxNoJsonStub {
        fn name(&self) -> &str {
            "stub"
        }
        fn default_model(&self) -> &str {
            "m"
        }
        fn default_mode_icon(&self, _m: Option<&str>) -> &'static str {
            "stub"
        }
        fn prompt_delivery(&self) -> PromptDelivery {
            PromptDelivery::Inline
        }
        fn get_launch_command(&self, _c: &LaunchConfig) -> Vec<String> {
            vec![]
        }
        fn get_environment(&self, _c: &LaunchConfig) -> BTreeMap<String, String> {
            BTreeMap::new()
        }
        fn get_ready_signal(&self) -> ReadySignal {
            ReadySignal {
                sentinel: None,
                fallback_ms: 0,
            }
        }
        fn compose_launch_prompt(&self, _i: ComposePromptInput) -> ComposePromptResult {
            ComposePromptResult::default()
        }
        fn default_channel(&self) -> Channel {
            Channel::Tmux
        }
        fn list_models(&self) -> AsyncResult<ListModelsResult> {
            Box::pin(async { ListModelsResult::default() })
        }
    }

    #[test]
    fn resolve_effective_default_channel_falls_back_and_honors_overrides() {
        let empty: BTreeMap<CliId, Channel> = BTreeMap::new();
        let claude = resolve_plugin(CliId::Claude); // default Json, supports_json
        let cursor = resolve_plugin(CliId::Cursor); // default Json, supports_json

        // 1. Empty overrides -> the plugin's own default.
        assert_eq!(
            resolve_effective_default_channel(&empty, CliId::Claude, &*claude),
            Channel::Json
        );

        // 2. Override present for the queried cli wins over the plugin.
        let mut ov = BTreeMap::new();
        ov.insert(CliId::Claude, Channel::Tmux);
        assert_eq!(
            resolve_effective_default_channel(&ov, CliId::Claude, &*claude),
            Channel::Tmux
        );

        // 3. Override for a DIFFERENT cli doesn't affect the queried one.
        assert_eq!(
            resolve_effective_default_channel(&ov, CliId::Cursor, &*cursor),
            Channel::Json
        );

        // 4. A persisted Json override for a !supports_json plugin falls back
        //    to that plugin's own default (total-ness — round-2 M4), not Json.
        let mut ov_json = BTreeMap::new();
        ov_json.insert(CliId::Claude, Channel::Json);
        let stub = TmuxNoJsonStub;
        assert_eq!(
            resolve_effective_default_channel(&ov_json, CliId::Claude, &stub),
            Channel::Tmux
        );
    }
}
