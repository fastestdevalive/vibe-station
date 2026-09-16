//! `routes/settings.ts` — GET/PATCH /settings.
//!
//! Ports `daemon/src/routes/settings.ts` (69 LOC) and `services/config.ts`:
//! - `GET /settings`
//! - `PATCH /settings`
//!
//! Manages user-configurable settings stored in `~/.vibe-station/config.json`.
//! Preserves transient main config fields on update.

use std::path::{Path, PathBuf};
use vst_agents::home::home_dir;
use vst_git::paths::Paths;
use vst_types::rest::settings::{PatchSettingsBody, PatchSettingsResult, Settings};

/// Errors returned by `PATCH /settings`.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SettingsRouteError {
    #[error("validation_error: defaultProjectsDir must be an absolute path")]
    DefaultProjectsDirNotAbsolute,
    #[error("validation_error: skillPaths must all be absolute paths")]
    SkillPathsNotAbsolute,
    #[error("internal_error: {0}")]
    Internal(String),
}

impl SettingsRouteError {
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::DefaultProjectsDirNotAbsolute | Self::SkillPathsNotAbsolute => "validation_error",
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

/// Default projects dir (`~/projects`).
pub fn default_projects_dir() -> String {
    home_dir().join("projects").to_string_lossy().to_string()
}

/// Handler for `/settings`.
#[derive(Clone, Debug)]
pub struct SettingsRoutes {
    paths: Paths,
}

impl SettingsRoutes {
    pub fn new(paths: Paths) -> Self {
        Self { paths }
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

        Settings {
            default_projects_dir: Some(default_projects_dir),
            skill_paths: Some(skill_paths),
            pid,
            port,
            cli_token,
            tauri_token,
            browser_epoch,
            started_at,
            home_dir: home_dir().to_string_lossy().to_string(),
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

        let mut raw = self.read_raw_config().await;
        if !raw.is_object() {
            raw = serde_json::json!({});
        }

        if let Some(dir) = body.default_projects_dir {
            raw["defaultProjectsDir"] = serde_json::Value::String(dir);
        }

        if let Some(paths) = body.skill_paths {
            // Deduplicate preserving order
            let mut deduped = Vec::new();
            for p in paths {
                if !deduped.contains(&p) {
                    deduped.push(p);
                }
            }
            raw["skillPaths"] = serde_json::to_value(deduped).unwrap();
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

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o600);
            let _ = tokio::fs::set_permissions(&cfg_path, perms).await;
        }

        Ok(PatchSettingsResult { ok: true })
    }
}
