//! `routes/settings.ts` — GET/PATCH /settings.
//!
//! Ports `daemon/src/routes/settings.ts` (69 LOC) and `services/config.ts`:
//! - `GET /settings`
//! - `PATCH /settings`
//!
//! Manages user-configurable settings stored in `~/.vibe-station/config.json`.
//! Preserves transient main config fields on update.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use vst_agents::home::home_dir;
use vst_agents::skill_resolution;
use vst_git::paths::Paths;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::settings::{
    MarkdownStyle, PatchSettingsBody, PatchSettingsResult, Settings,
};

/// Errors returned by `PATCH /settings`.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SettingsRouteError {
    #[error("validation_error: defaultProjectsDir must be an absolute path")]
    DefaultProjectsDirNotAbsolute,
    #[error("validation_error: skillPaths must all be absolute paths")]
    SkillPathsNotAbsolute,
    #[error("validation_error: invalid markdown_style value")]
    InvalidMarkdownStyle,
    #[error("internal_error: {0}")]
    Internal(String),
}

impl SettingsRouteError {
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::DefaultProjectsDirNotAbsolute
            | Self::SkillPathsNotAbsolute
            | Self::InvalidMarkdownStyle => "validation_error",
            Self::Internal(_) => "internal_error",
        }
    }
}

/// Default directories for harness skills.
pub fn default_skill_paths() -> Vec<String> {
    let home = home_dir();
    let claude_dir = std::env::var("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".claude"))
        .join("skills");
    let gemini_dir = std::env::var("GEMINI_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".gemini"))
        .join("skills");
    vec![
        claude_dir.to_string_lossy().to_string(),
        gemini_dir.to_string_lossy().to_string(),
    ]
}

/// The effective `skillPaths` set: the user's configured paths (or the
/// global defaults, if none configured/cleared) plus vibe-station's own
/// bundled skill dir, always appended. Shared by daemon startup (`main.rs`)
/// and `PATCH /settings`'s live catalog refresh so the two can't silently
/// diverge — that divergence is exactly the class of bug this module's
/// skill-catalog consolidation exists to eliminate.
pub fn effective_skill_paths(configured: &[String], vst_home: &Path) -> Vec<String> {
    let mut paths: Vec<String> = if configured.is_empty() {
        default_skill_paths()
    } else {
        configured.to_vec()
    };
    paths.push(vst_home.join("skill").to_string_lossy().to_string());
    paths
}

/// Default projects dir (`~/projects`).
pub fn default_projects_dir() -> String {
    home_dir().join("projects").to_string_lossy().to_string()
}

/// Default theme id.
pub fn default_theme_id() -> String {
    "vibestation-dark".to_string()
}

/// Handler for `/settings`.
#[derive(Clone, Debug)]
pub struct SettingsRoutes {
    paths: Paths,
    broadcaster: Broadcaster,
    // Serializes `patch_settings`'s read-modify-write of config.json. Shared
    // across every clone of `SettingsRoutes` (Axum clones the handler state
    // per request) via the Arc, so two concurrent PATCHes (e.g. clicking two
    // search toggles in quick succession) can't both read the pre-mutation
    // JSON and have the second write silently discard the first's field.
    write_lock: Arc<tokio::sync::Mutex<()>>,
}

impl SettingsRoutes {
    pub fn new(paths: Paths, broadcaster: Broadcaster) -> Self {
        Self {
            paths,
            broadcaster,
            write_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    fn config_path(&self) -> PathBuf {
        self.paths.vst_home().join("config.json")
    }

    /// Read raw serde_json::Value from config.json, returning empty Object if missing.
    async fn read_raw_config(&self) -> serde_json::Value {
        let p = self.config_path();
        match tokio::fs::read_to_string(&p).await {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({})),
            Err(_) => serde_json::json!({}),
        }
    }

    /// `GET /settings`
    pub async fn get_settings(&self) -> Settings {
        let raw = self.read_raw_config().await;

        let default_projects_dir = raw
            .get("defaultProjectsDir")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(default_projects_dir);

        let skill_paths = raw
            .get("skillPaths")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<String>>()
            })
            .unwrap_or_else(default_skill_paths);

        let theme_id = raw
            .get("themeId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(default_theme_id);

        let markdown_style = raw
            .get("markdownStyle")
            .and_then(|v| serde_json::from_value::<MarkdownStyle>(v.clone()).ok());

        let pid = raw.get("pid").and_then(|v| v.as_i64());
        let port = raw.get("port").and_then(|v| v.as_i64());
        let cli_token = raw
            .get("cliToken")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let tauri_token = raw
            .get("tauriToken")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let browser_epoch = raw.get("browserEpoch").and_then(|v| v.as_i64());
        let started_at = raw
            .get("startedAt")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let search_case_sensitive = raw
            .get("searchCaseSensitive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let search_regex = raw.get("searchRegex").and_then(|v| v.as_bool()).unwrap_or(false);
        let search_whole_word = raw
            .get("searchWholeWord")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        Settings {
            default_projects_dir: Some(default_projects_dir),
            skill_paths: Some(skill_paths),
            theme_id: Some(theme_id),
            markdown_style,
            pid,
            port,
            cli_token,
            tauri_token,
            browser_epoch,
            started_at,
            home_dir: home_dir().to_string_lossy().to_string(),
            search_case_sensitive: Some(search_case_sensitive),
            search_regex: Some(search_regex),
            search_whole_word: Some(search_whole_word),
        }
    }

    /// `PATCH /settings`
    pub async fn patch_settings(
        &self,
        body: PatchSettingsBody,
    ) -> Result<PatchSettingsResult, SettingsRouteError> {
        if let Some(ref dir) = body.default_projects_dir {
            if dir.is_empty() || !Path::new(dir).is_absolute() {
                return Err(SettingsRouteError::DefaultProjectsDirNotAbsolute);
            }
        }

        if let Some(ref paths) = body.skill_paths {
            for p in paths {
                if p.is_empty() || !Path::new(p).is_absolute() {
                    return Err(SettingsRouteError::SkillPathsNotAbsolute);
                }
            }
        }

        if let Some(ref theme_id) = body.theme_id {
            if theme_id.is_empty() {
                return Err(SettingsRouteError::InvalidMarkdownStyle);
            }
        }

        if let Some(ref style) = body.markdown_style {
            validate_markdown_style(style)?;
        }

        // Hold the write lock across the whole read-modify-write cycle (see
        // the field doc on `write_lock`) — released when `_guard` drops at
        // function end.
        let _guard = self.write_lock.lock().await;

        let mut raw = self.read_raw_config().await;
        if !raw.is_object() {
            raw = serde_json::json!({});
        }

        if let Some(dir) = body.default_projects_dir {
            raw["defaultProjectsDir"] = serde_json::Value::String(dir);
        }

        // Computed here (validated + deduped) but not applied to the live
        // catalog until AFTER the config write below succeeds — applying it
        // first would leave the live catalog ahead of what's actually
        // persisted if the write then fails (e.g. disk full), surviving
        // until the next restart re-reads the (unchanged) file.
        let mut pending_skill_paths_refresh: Option<Vec<String>> = None;

        if let Some(paths) = body.skill_paths {
            // Deduplicate preserving order
            let mut deduped = Vec::new();
            for p in paths {
                if !deduped.contains(&p) {
                    deduped.push(p);
                }
            }
            raw["skillPaths"] = serde_json::to_value(deduped.clone()).unwrap();
            pending_skill_paths_refresh =
                Some(effective_skill_paths(&deduped, self.paths.vst_home()));
        }

        // Resulting theme/markdown state, broadcast to other tabs after write.
        let result_theme_id: Option<String> = if let Some(theme_id) = body.theme_id {
            raw["themeId"] = serde_json::Value::String(theme_id.clone());
            Some(theme_id)
        } else {
            raw.get("themeId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        };

        // reset_markdown_style is processed before any same-request
        // markdown_style value, so it clears first and a value re-sets it.
        let pre_apply_markdown_style: Option<MarkdownStyle> =
            if body.reset_markdown_style == Some(true) {
                if let Some(obj) = raw.as_object_mut() {
                    obj.remove("markdownStyle");
                }
                None
            } else {
                raw.get("markdownStyle")
                    .and_then(|v| serde_json::from_value::<MarkdownStyle>(v.clone()).ok())
            };

        let result_markdown_style: Option<MarkdownStyle> = if let Some(style) = body.markdown_style {
            raw["markdownStyle"] = serde_json::to_value(style.clone()).unwrap();
            Some(style)
        } else {
            pre_apply_markdown_style
        };

        if let Some(v) = body.search_case_sensitive {
            raw["searchCaseSensitive"] = serde_json::Value::Bool(v);
        }
        if let Some(v) = body.search_regex {
            raw["searchRegex"] = serde_json::Value::Bool(v);
        }
        if let Some(v) = body.search_whole_word {
            raw["searchWholeWord"] = serde_json::Value::Bool(v);
        }

        let vst_home = self.paths.vst_home();
        tokio::fs::create_dir_all(vst_home)
            .await
            .map_err(|e| SettingsRouteError::Internal(e.to_string()))?;

        let cfg_path = self.config_path();
        let content = serde_json::to_string_pretty(&raw)
            .map_err(|e| SettingsRouteError::Internal(e.to_string()))?;

        tokio::fs::write(&cfg_path, content)
            .await
            .map_err(|e| SettingsRouteError::Internal(e.to_string()))?;

        // Config write succeeded — now safe to refresh the shared,
        // live-watched skill catalog so the Rich Chat composer / draft
        // composer both reflect the change without a daemon restart.
        if let Some(effective) = pending_skill_paths_refresh {
            skill_resolution::set_skill_paths(&effective).await;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o600);
            let _ = tokio::fs::set_permissions(&cfg_path, perms).await;
        }

        self.broadcaster.send(ServerEvent::SettingsThemeUpdated {
            theme_id: result_theme_id,
            markdown_style: result_markdown_style,
        });

        Ok(PatchSettingsResult { ok: true })
    }
}

/// Validate the CSS-value shape of a `MarkdownStyle`. Only the shape of the
/// values is checked (e.g. `size` must be a CSS length, `color` a CSS color,
/// `italic.style` one of `italic`/`oblique`); nothing is checked against any
/// theme or font registry.
fn validate_markdown_style(style: &MarkdownStyle) -> Result<(), SettingsRouteError> {
    for heading in [
        &style.h1,
        &style.h2,
        &style.h3,
        &style.h4,
        &style.h5,
        &style.h6,
    ] {
        if let Some(h) = heading {
            if let Some(ref size) = h.size {
                if !is_css_length(size) {
                    return Err(SettingsRouteError::InvalidMarkdownStyle);
                }
            }
            if let Some(ref color) = h.color {
                if !is_css_color(color) {
                    return Err(SettingsRouteError::InvalidMarkdownStyle);
                }
            }
        }
    }

    if let Some(ref bold) = style.bold {
        if let Some(ref color) = bold.color {
            if !is_css_color(color) {
                return Err(SettingsRouteError::InvalidMarkdownStyle);
            }
        }
    }

    if let Some(ref italic) = style.italic {
        if let Some(ref s) = italic.style {
            if s != "italic" && s != "oblique" {
                return Err(SettingsRouteError::InvalidMarkdownStyle);
            }
        }
        if let Some(ref color) = italic.color {
            if !is_css_color(color) {
                return Err(SettingsRouteError::InvalidMarkdownStyle);
            }
        }
    }

    if let Some(ref inline) = style.inline_code {
        if let Some(ref bg) = inline.bg {
            if !is_css_color(bg) {
                return Err(SettingsRouteError::InvalidMarkdownStyle);
            }
        }
        if let Some(ref color) = inline.color {
            if !is_css_color(color) {
                return Err(SettingsRouteError::InvalidMarkdownStyle);
            }
        }
    }

    if let Some(ref block) = style.code_block {
        if let Some(ref bg) = block.bg {
            if !is_css_color(bg) {
                return Err(SettingsRouteError::InvalidMarkdownStyle);
            }
        }
        if let Some(ref color) = block.color {
            if !is_css_color(color) {
                return Err(SettingsRouteError::InvalidMarkdownStyle);
            }
        }
        if let Some(ref border) = block.border {
            if !is_css_color(border) {
                return Err(SettingsRouteError::InvalidMarkdownStyle);
            }
        }
    }

    if let Some(ref font) = style.code_font_family {
        if font.trim().is_empty() {
            return Err(SettingsRouteError::InvalidMarkdownStyle);
        }
    }

    if let Some(ref quote) = style.blockquote {
        if let Some(ref border) = quote.border {
            if !is_css_color(border) {
                return Err(SettingsRouteError::InvalidMarkdownStyle);
            }
        }
        if let Some(ref color) = quote.color {
            if !is_css_color(color) {
                return Err(SettingsRouteError::InvalidMarkdownStyle);
            }
        }
    }

    if let Some(ref link) = style.link {
        if let Some(ref color) = link.color {
            if !is_css_color(color) {
                return Err(SettingsRouteError::InvalidMarkdownStyle);
            }
        }
    }

    Ok(())
}

/// True if `s` is a plausible CSS length (`<number><unit>` or a bare number).
fn is_css_length(s: &str) -> bool {
    let s = s.trim();
    if s.is_empty() {
        return false;
    }
    let s = s.strip_prefix('-').unwrap_or(s);
    let split = s.find(|c: char| !c.is_ascii_digit() && c != '.');
    match split {
        Some(idx) => {
            let num = &s[..idx];
            let unit = &s[idx..];
            if num.is_empty() || num.parse::<f64>().is_err() {
                return false;
            }
            matches!(
                unit,
                "em" | "rem" | "px" | "pt" | "pc" | "cm" | "mm" | "in" | "%" | "ch" | "ex"
                    | "vh" | "vw" | "vmin" | "vmax"
            )
        }
        None => s.parse::<f64>().is_ok(),
    }
}

/// True if `s` is a plausible CSS color (hex, rgb()/hsl(), or a named color).
fn is_css_color(s: &str) -> bool {
    let s = s.trim();
    if s.is_empty() {
        return false;
    }
    if s.starts_with('#') {
        let hex = &s[1..];
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    if s.starts_with("rgb") || s.starts_with("hsl") {
        return true;
    }
    // Named CSS color (subset).
    let named = [
        "black", "white", "red", "green", "blue", "yellow", "cyan", "magenta", "gray", "grey",
        "orange", "purple", "brown", "pink", "gold", "silver", "navy", "teal", "maroon", "olive",
        "lime", "aqua", "fuchsia", "transparent", "currentColor",
    ];
    named.contains(&s.to_ascii_lowercase().as_str())
}
