use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::http::StatusCode;
use axum::Json;
use serde_json::json;
use vst_git::paths::Paths;
use vst_lsp::{LspError, LspManager, LspRequestKind, LspResponse, WorkspaceKey};
use vst_store::StoreHandle;
use vst_types::domain::ProjectRecord;
use vst_types::rest::lsp::{
    Location, LspDefinitionResponse, LspFileRef, LspHoverResponse, LspLanguageSurveyResponse,
    LspOutlineResponse, LspReferencesResponse, LspStatusResponse, OutlineSymbol, ReferenceEntry,
    ReferenceGroup,
};

#[derive(Debug, thiserror::Error)]
pub enum LspRouteError {
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("External token expired")]
    ExternalTokenExpired,
    #[error("Language server still starting")]
    NotReady(String),
    #[error("Code navigation is disabled for this workspace")]
    Disabled,
    #[error("LSP operation unsupported: {0}")]
    Unsupported(String),
    #[error("Language server error: {0}")]
    ServerError(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

impl From<LspError> for LspRouteError {
    fn from(e: LspError) -> Self {
        match e {
            LspError::NotFound => LspRouteError::NotFound("Language server not found".to_string()),
            LspError::Starting => {
                LspRouteError::NotReady("Language server still starting".to_string())
            }
            LspError::Disabled => LspRouteError::Disabled,
            LspError::Unsupported => {
                LspRouteError::Unsupported("LSP operation unsupported".to_string())
            }
            LspError::Timeout => {
                LspRouteError::ServerError("Language server request timed out".to_string())
            }
            LspError::ProcessDied => {
                LspRouteError::ServerError("Language server process died".to_string())
            }
            LspError::ServerError(msg) => LspRouteError::ServerError(msg),
            LspError::UnknownExternalToken => LspRouteError::ExternalTokenExpired,
        }
    }
}

impl From<crate::search_util::RgSearchError> for LspRouteError {
    fn from(e: crate::search_util::RgSearchError) -> Self {
        match e {
            crate::search_util::RgSearchError::NotFound => {
                LspRouteError::Internal("ripgrep not found on PATH".into())
            }
            crate::search_util::RgSearchError::ProcessError(msg) => {
                LspRouteError::Internal(msg)
            }
        }
    }
}

fn extract_word_at_pos(content: &str, line: u32, character: u32) -> Option<String> {
    let line_str = content.lines().nth(line as usize)?;
    let byte_offset = vst_lsp::utf16_col_to_byte_offset(line_str, character);

    let is_ident = |c: char| c.is_alphanumeric() || c == '_';
    let chars: Vec<(usize, char)> = line_str.char_indices().collect();
    if chars.is_empty() {
        return None;
    }

    let mut target_idx = None;
    for (i, &(byte_idx, c)) in chars.iter().enumerate() {
        let char_end = byte_idx + c.len_utf8();
        if byte_offset >= byte_idx && byte_offset < char_end {
            if is_ident(c) {
                target_idx = Some(i);
            }
            break;
        }
    }

    let idx = target_idx?;
    let mut start_idx = idx;
    while start_idx > 0 && is_ident(chars[start_idx - 1].1) {
        start_idx -= 1;
    }
    let mut end_idx = idx;
    while end_idx + 1 < chars.len() && is_ident(chars[end_idx + 1].1) {
        end_idx += 1;
    }

    let start_byte = chars[start_idx].0;
    let end_byte = chars[end_idx].0 + chars[end_idx].1.len_utf8();
    let word = &line_str[start_byte..end_byte];
    if word.is_empty() {
        None
    } else {
        Some(word.to_string())
    }
}

pub fn lsp_err_to_response(
    err: LspRouteError,
) -> (StatusCode, Json<serde_json::Value>) {
    match err {
        LspRouteError::NotFound(msg) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": msg, "code": "NOT_FOUND" })),
        ),
        LspRouteError::ExternalTokenExpired => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "External token expired", "code": "LSP_EXTERNAL_TOKEN_EXPIRED" })),
        ),
        LspRouteError::NotReady(msg) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": msg, "code": "LSP_NOT_READY" })),
        ),
        LspRouteError::Disabled => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "Code navigation is disabled for this workspace", "code": "LSP_DISABLED" })),
        ),
        LspRouteError::Unsupported(msg) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": msg, "code": "LSP_UNSUPPORTED" })),
        ),
        LspRouteError::ServerError(msg) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": msg, "code": "LSP_SERVER_ERROR" })),
        ),
        LspRouteError::Internal(msg) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": msg, "code": "LSP_ERROR" })),
        ),
    }
}

#[derive(Clone)]
pub struct LspRoutes {
    pub store: StoreHandle,
    pub paths: Paths,
    pub lsp_manager: Arc<LspManager>,
}

impl LspRoutes {
    pub fn new(store: StoreHandle, paths: Paths, lsp_manager: Arc<LspManager>) -> Self {
        Self {
            store,
            paths,
            lsp_manager,
        }
    }

    pub async fn resolve_workspace_root(
        &self,
        workspace: &WorkspaceKey,
    ) -> Result<PathBuf, LspRouteError> {
        match workspace {
            WorkspaceKey::Worktree {
                project_id,
                worktree_id,
            } => {
                let project = self.find_project_for_worktree(worktree_id).await?;
                if &project.id != project_id && !project_id.is_empty() {
                    // Mismatch guard
                }
                Ok(self.paths.worktree_path(&project.id, worktree_id))
            }
            WorkspaceKey::Project { project_id } => {
                let project = self.store.get_project(project_id).await.ok_or_else(|| {
                    LspRouteError::NotFound(format!("Project '{project_id}' not found"))
                })?;
                Ok(PathBuf::from(&project.absolute_path))
            }
        }
    }

    async fn find_project_for_worktree(
        &self,
        wt_id: &str,
    ) -> Result<ProjectRecord, LspRouteError> {
        let all = self.store.get_all_projects().await;
        for p in all {
            if p.worktrees.iter().any(|w| w.id == wt_id) {
                return Ok(p);
            }
        }
        Err(LspRouteError::NotFound(format!(
            "Worktree '{wt_id}' not found"
        )))
    }

    pub async fn is_lsp_enabled(&self, workspace: &WorkspaceKey) -> Result<bool, LspRouteError> {
        match workspace {
            WorkspaceKey::Worktree { worktree_id, .. } => {
                let project = self.find_project_for_worktree(worktree_id).await?;
                let wt = project
                    .worktrees
                    .iter()
                    .find(|w| &w.id == worktree_id)
                    .ok_or_else(|| LspRouteError::NotFound(format!("Worktree '{worktree_id}' not found")))?;
                Ok(wt.lsp_enabled.unwrap_or(false))
            }
            WorkspaceKey::Project { project_id } => {
                let project = self.store.get_project(project_id).await.ok_or_else(|| {
                    LspRouteError::NotFound(format!("Project '{project_id}' not found"))
                })?;
                Ok(project.lsp_enabled.unwrap_or(false))
            }
        }
    }

    pub async fn status(
        &self,
        workspace: WorkspaceKey,
        path: &str,
    ) -> Result<LspStatusResponse, LspRouteError> {
        // Verify workspace exists
        let _ = self.resolve_workspace_root(&workspace).await?;
        let enabled = self.is_lsp_enabled(&workspace).await?;
        let (status, language) = self.lsp_manager.status(&workspace, path, enabled).await;
        Ok(LspStatusResponse { status, language })
    }

    /// Per-language status for every language actually DETECTED in this
    /// workspace's file tree (not just ones a server has been spawned for —
    /// a language with no live handle yet still gets an accurate
    /// `not_found`/`stopped`/`disabled` status, same as a single-file
    /// `status()` call would report for a file of that language).
    ///
    /// Corrected from an earlier version of this method that listed every
    /// language `LspManager` happened to have a `ServerHandle` for — that
    /// answered "what have I spawned so far", not "what languages does this
    /// worktree/project actually have", which is what the UI's per-worktree
    /// status popup needs (a worktree can have leftover/incidental servers
    /// from files that were never really part of the project, and a
    /// genuinely-present language with no handle yet was invisible).
    pub async fn statuses(
        &self,
        workspace: WorkspaceKey,
    ) -> Result<Vec<(String, vst_types::rest::lsp::LspStatus)>, LspRouteError> {
        let root = self.resolve_workspace_root(&workspace).await?;
        let enabled = self.is_lsp_enabled(&workspace).await?;

        let listing = vst_ws::services::file_list::FileList::new()
            .list_files(root)
            .await;

        let mut seen = std::collections::HashSet::new();
        let mut languages: Vec<&'static str> = Vec::new();
        for file in &listing.files {
            let ext = std::path::Path::new(file)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            if ext.is_empty() {
                continue;
            }
            if let Some(cfg) = vst_lsp::lookup(ext) {
                if seen.insert(cfg.language) {
                    languages.push(cfg.language);
                }
            }
        }

        let mut out = Vec::with_capacity(languages.len());
        for lang in languages {
            let Some(cfg) = vst_lsp::lookup_by_language(lang) else { continue };
            let Some(ext) = cfg.extensions.first() else { continue };
            let synthetic_path = format!("_.{ext}");
            let (status, _) = self
                .lsp_manager
                .status(&workspace, &synthetic_path, enabled)
                .await;
            out.push((lang.to_string(), status));
        }
        Ok(out)
    }

    /// Host-wide survey of every registered language server — no workspace
    /// resolution, no `Result`: the registry is a static compiled-in list and
    /// the only I/O is a `$PATH` scan, so this call cannot fail.
    pub fn language_survey(&self) -> LspLanguageSurveyResponse {
        LspLanguageSurveyResponse {
            languages: self.lsp_manager.language_survey(),
        }
    }

    pub async fn definition(
        &self,
        workspace: WorkspaceKey,
        file: LspFileRef,
        line: u32,
        character: u32,
    ) -> Result<LspDefinitionResponse, LspRouteError> {
        let root = self.resolve_workspace_root(&workspace).await?;
        let enabled = self.is_lsp_enabled(&workspace).await?;

        // Determine language
        let lang = match &file {
            LspFileRef::Workspace { path } => {
                let ext = std::path::Path::new(path)
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                let cfg = vst_lsp::lookup(ext).ok_or_else(|| {
                    LspRouteError::Unsupported(format!("Unsupported language for file: {path}"))
                })?;
                cfg.language
            }
            LspFileRef::External { token } => {
                let path = self
                    .lsp_manager
                    .resolve_external_token(&workspace, token)
                    .await
                    .ok_or(LspRouteError::ExternalTokenExpired)?;
                let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
                let cfg = vst_lsp::lookup(ext).ok_or_else(|| {
                    LspRouteError::Unsupported("Unsupported language for external file".to_string())
                })?;
                cfg.language
            }
        };

        let abs_path = match &file {
            // Path confinement: reject absolute / escaping / sensitive paths
            // before we ever read the file for the text-search fallback.
            LspFileRef::Workspace { path } => {
                vst_lsp::resolve_workspace_path(&root, path)?
            }
            LspFileRef::External { token } => {
                self.lsp_manager
                    .resolve_external_token(&workspace, token)
                    .await
                    .ok_or(LspRouteError::ExternalTokenExpired)?
            }
        };

        let req_res = self
            .lsp_manager
            .request(
                workspace.clone(),
                &root,
                lang,
                file,
                LspRequestKind::Definition,
                Some((line, character)),
                enabled,
            )
            .await;

        let resp = match req_res {
            Ok(r) => r,
            Err(e) => {
                let fallback_eligible = matches!(
                    e,
                    vst_lsp::LspError::Disabled
                        | vst_lsp::LspError::Starting
                        | vst_lsp::LspError::NotFound
                        | vst_lsp::LspError::Unsupported
                );
                if fallback_eligible && !self.lsp_manager.has_ever_been_ready(&workspace, lang).await {
                    let word_opt = if let Ok(content) = tokio::fs::read_to_string(&abs_path).await {
                        extract_word_at_pos(&content, line, character)
                    } else {
                        None
                    };

                    if let Some(word_text) = word_opt {
                        let raw_matches = crate::search_util::rg_search(
                            &root,
                            &word_text,
                            false,
                            true,
                            true,
                            None,
                            50,
                        )
                        .await?;

                        let locations = raw_matches
                            .into_iter()
                            .map(|m| {
                                let rel = m.path.strip_prefix("./").unwrap_or(&m.path).to_string();
                                Location {
                                    line: m.line_number.saturating_sub(1),
                                    character: vst_lsp::byte_offset_to_utf16_col(&m.line_text, m.start_byte),
                                    preview: m.line_text,
                                    confidence: "text".into(),
                                    external: false,
                                    path: Some(rel),
                                    token: None,
                                    display_path: None,
                                }
                            })
                            .collect();

                        return Ok(LspDefinitionResponse { locations });
                    }
                }
                return Err(e.into());
            }
        };

        match resp {
            LspResponse::Definition(locs) => {
                let mut locations = Vec::new();
                for loc in locs {
                    let is_internal = loc.abs_path.starts_with(&root);
                    if is_internal {
                        let rel = loc.abs_path.strip_prefix(&root).unwrap_or(&loc.abs_path);
                        locations.push(Location {
                            line: loc.line,
                            character: loc.character,
                            preview: loc.preview,
                            external: false,
                            path: Some(rel.to_string_lossy().to_string()),
                            token: None,
                            display_path: None,
                            confidence: "lsp".into(),
                        });
                    } else {
                        let mut token = None;
                        let mut display_path = None;
                        if let Ok(canon) = loc.abs_path.canonicalize() {
                            if canon.is_file() && !vst_lsp::is_sensitive_path(&canon, Some(self.paths.vst_home())) {
                                let t = self.lsp_manager.get_or_mint_external_token(&workspace, &canon).await;
                                display_path = Some(canon.to_string_lossy().to_string());
                                token = Some(t);
                            }
                        }
                        locations.push(Location {
                            line: loc.line,
                            character: loc.character,
                            preview: loc.preview,
                            external: true,
                            path: None,
                            token,
                            display_path,
                            confidence: "lsp".into(),
                        });
                    }
                }
                Ok(LspDefinitionResponse { locations })
            }
            _ => Err(LspRouteError::Internal("Unexpected LSP response variant".to_string())),
        }
    }

    pub async fn external_file(
        &self,
        workspace: WorkspaceKey,
        token: &str,
    ) -> Result<crate::file_serving::FileResponse, LspRouteError> {
        // Verify workspace exists
        let _ = self.resolve_workspace_root(&workspace).await?;

        // Resolve token from LspManager
        let path = self
            .lsp_manager
            .resolve_external_token(&workspace, token)
            .await
            .ok_or(LspRouteError::ExternalTokenExpired)?;

        // Canonicalize and 4.0 mitigations
        let canon = path
            .canonicalize()
            .map_err(|_| LspRouteError::ExternalTokenExpired)?;

        if !canon.is_file() {
            return Err(LspRouteError::ExternalTokenExpired);
        }

        if vst_lsp::is_sensitive_path(&canon, Some(self.paths.vst_home())) {
            return Err(LspRouteError::ExternalTokenExpired);
        }

        crate::file_serving::read_file_response(&canon)
            .await
            .map_err(|e| match e {
                crate::file_serving::FileServingError::NotFound(_) => {
                    LspRouteError::ExternalTokenExpired
                }
                crate::file_serving::FileServingError::TooLarge => {
                    LspRouteError::Unsupported("File too large (>50MB)".to_string())
                }
                crate::file_serving::FileServingError::BinaryTooLarge => {
                    LspRouteError::Unsupported("Binary file (>1MB)".to_string())
                }
                other => LspRouteError::Internal(other.to_string()),
            })
    }

    pub async fn hover(
        &self,
        workspace: WorkspaceKey,
        file: LspFileRef,
        line: u32,
        character: u32,
    ) -> Result<LspHoverResponse, LspRouteError> {
        let root = self.resolve_workspace_root(&workspace).await?;
        let enabled = self.is_lsp_enabled(&workspace).await?;

        // Determine language
        let lang = match &file {
            LspFileRef::Workspace { path } => {
                let ext = std::path::Path::new(path)
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                let cfg = vst_lsp::lookup(ext).ok_or_else(|| {
                    LspRouteError::Unsupported(format!("Unsupported language for file: {path}"))
                })?;
                cfg.language
            }
            LspFileRef::External { token } => {
                let path = self
                    .lsp_manager
                    .resolve_external_token(&workspace, token)
                    .await
                    .ok_or(LspRouteError::ExternalTokenExpired)?;
                let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
                let cfg = vst_lsp::lookup(ext).ok_or_else(|| {
                    LspRouteError::Unsupported("Unsupported language for external file".to_string())
                })?;
                cfg.language
            }
        };

        let resp = self
            .lsp_manager
            .request(
                workspace.clone(),
                &root,
                lang,
                file,
                LspRequestKind::Hover,
                Some((line, character)),
                enabled,
            )
            .await?;

        match resp {
            LspResponse::Hover(val) => Ok(parse_hover_response(val)),
            _ => Err(LspRouteError::Internal("Unexpected LSP response variant".to_string())),
        }
    }

    pub async fn references(
        &self,
        workspace: WorkspaceKey,
        file: LspFileRef,
        line: u32,
        character: u32,
        cursor: Option<String>,
    ) -> Result<LspReferencesResponse, LspRouteError> {
        let root = self.resolve_workspace_root(&workspace).await?;
        let enabled = self.is_lsp_enabled(&workspace).await?;

        // Determine language
        let lang = match &file {
            LspFileRef::Workspace { path } => {
                let ext = std::path::Path::new(path)
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                let cfg = vst_lsp::lookup(ext).ok_or_else(|| {
                    LspRouteError::Unsupported(format!("Unsupported language for file: {path}"))
                })?;
                cfg.language
            }
            LspFileRef::External { token } => {
                let path = self
                    .lsp_manager
                    .resolve_external_token(&workspace, token)
                    .await
                    .ok_or(LspRouteError::ExternalTokenExpired)?;
                let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
                let cfg = vst_lsp::lookup(ext).ok_or_else(|| {
                    LspRouteError::Unsupported("Unsupported language for external file".to_string())
                })?;
                cfg.language
            }
        };

        let abs_path = match &file {
            // Path confinement: reject absolute / escaping / sensitive paths
            // before we ever read the file for the text-search fallback.
            LspFileRef::Workspace { path } => {
                vst_lsp::resolve_workspace_path(&root, path)?
            }
            LspFileRef::External { token } => {
                self.lsp_manager
                    .resolve_external_token(&workspace, token)
                    .await
                    .ok_or(LspRouteError::ExternalTokenExpired)?
            }
        };

        let req_res = self
            .lsp_manager
            .request(
                workspace.clone(),
                &root,
                lang,
                file,
                LspRequestKind::References,
                Some((line, character)),
                enabled,
            )
            .await;

        let resp = match req_res {
            Ok(r) => r,
            Err(e) => {
                let fallback_eligible = matches!(
                    e,
                    vst_lsp::LspError::Disabled
                        | vst_lsp::LspError::Starting
                        | vst_lsp::LspError::NotFound
                        | vst_lsp::LspError::Unsupported
                );
                if fallback_eligible && !self.lsp_manager.has_ever_been_ready(&workspace, lang).await {
                    let word_opt = if let Ok(content) = tokio::fs::read_to_string(&abs_path).await {
                        extract_word_at_pos(&content, line, character)
                    } else {
                        None
                    };

                    if let Some(word_text) = word_opt {
                        let raw_matches = crate::search_util::rg_search(
                            &root,
                            &word_text,
                            false,
                            true,
                            true,
                            None,
                            50,
                        )
                        .await?;

                        let mut groups: Vec<ReferenceGroup> = Vec::new();
                        let mut file_indices: HashMap<String, usize> = HashMap::new();

                        for m in raw_matches {
                            let rel = m.path.strip_prefix("./").unwrap_or(&m.path).to_string();
                            let entry = ReferenceEntry {
                                line: m.line_number.saturating_sub(1),
                                character: vst_lsp::byte_offset_to_utf16_col(&m.line_text, m.start_byte),
                                preview: m.line_text,
                                is_declaration: false,
                                confidence: "text".into(),
                            };

                            if let Some(&idx) = file_indices.get(&rel) {
                                groups[idx].entries.push(entry);
                            } else {
                                let idx = groups.len();
                                file_indices.insert(rel.clone(), idx);
                                groups.push(ReferenceGroup {
                                    path: Some(rel),
                                    external: false,
                                    token: None,
                                    display_path: None,
                                    entries: vec![entry],
                                });
                            }
                        }

                        return Ok(LspReferencesResponse {
                            references: groups,
                            has_more: false,
                            cursor: None,
                        });
                    }
                }
                return Err(e.into());
            }
        };

        match resp {
            LspResponse::References(targets) => {
                let n = targets.len();
                let offset = cursor
                    .as_deref()
                    .and_then(|c| c.parse::<usize>().ok())
                    .unwrap_or(0);

                if offset >= n && n > 0 {
                    return Ok(LspReferencesResponse {
                        references: vec![],
                        has_more: false,
                        cursor: None,
                    });
                }

                let end = (offset + 50).min(n);
                let page_targets = if n == 0 { &[][..] } else { &targets[offset..end] };
                let has_more = end < n;
                let next_cursor = if has_more { Some(end.to_string()) } else { None };

                let mut groups: Vec<ReferenceGroup> = Vec::new();
                let mut file_indices: HashMap<PathBuf, usize> = HashMap::new();

                for target in page_targets {
                    let entry = ReferenceEntry {
                        line: target.line,
                        character: target.character,
                        preview: target.preview.clone(),
                        is_declaration: target.is_declaration,
                        confidence: "lsp".into(),
                    };

                    if let Some(&idx) = file_indices.get(&target.abs_path) {
                        groups[idx].entries.push(entry);
                    } else {
                        let is_internal = target.abs_path.starts_with(&root);
                        let group = if is_internal {
                            let rel = target.abs_path.strip_prefix(&root).unwrap_or(&target.abs_path);
                            ReferenceGroup {
                                path: Some(rel.to_string_lossy().to_string()),
                                external: false,
                                token: None,
                                display_path: None,
                                entries: vec![entry],
                            }
                        } else {
                            let mut token = None;
                            let mut display_path = None;
                            if let Ok(canon) = target.abs_path.canonicalize() {
                                if canon.is_file() && !vst_lsp::is_sensitive_path(&canon, Some(self.paths.vst_home())) {
                                    let t = self.lsp_manager.get_or_mint_external_token(&workspace, &canon).await;
                                    display_path = Some(canon.to_string_lossy().to_string());
                                    token = Some(t);
                                }
                            }
                            ReferenceGroup {
                                path: None,
                                external: true,
                                token,
                                display_path,
                                entries: vec![entry],
                            }
                        };
                        file_indices.insert(target.abs_path.clone(), groups.len());
                        groups.push(group);
                    }
                }

                Ok(LspReferencesResponse {
                    references: groups,
                    has_more,
                    cursor: next_cursor,
                })
            }
            _ => Err(LspRouteError::Internal("Unexpected LSP response variant".to_string())),
        }
    }

    pub async fn outline(
        &self,
        workspace: WorkspaceKey,
        file_param: String,
    ) -> Result<LspOutlineResponse, LspRouteError> {
        let file = if let Some(token) = file_param.strip_prefix("external:") {
            LspFileRef::External {
                token: token.to_string(),
            }
        } else if let Some(path) = file_param.strip_prefix("workspace:") {
            LspFileRef::Workspace {
                path: path.to_string(),
            }
        } else {
            LspFileRef::Workspace {
                path: file_param,
            }
        };

        let root = self.resolve_workspace_root(&workspace).await?;
        let enabled = self.is_lsp_enabled(&workspace).await?;

        // Determine language
        let lang = match &file {
            LspFileRef::Workspace { path } => {
                let ext = std::path::Path::new(path)
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                let Some(cfg) = vst_lsp::lookup(ext) else {
                    return Ok(LspOutlineResponse::Unsupported { unsupported: true });
                };
                cfg.language
            }
            LspFileRef::External { token } => {
                let path = self
                    .lsp_manager
                    .resolve_external_token(&workspace, token)
                    .await
                    .ok_or(LspRouteError::ExternalTokenExpired)?;
                let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
                let Some(cfg) = vst_lsp::lookup(ext) else {
                    return Ok(LspOutlineResponse::Unsupported { unsupported: true });
                };
                cfg.language
            }
        };

        let resp = match self
            .lsp_manager
            .request(
                workspace.clone(),
                &root,
                lang,
                file,
                LspRequestKind::Outline,
                None,
                enabled,
            )
            .await
        {
            Ok(r) => r,
            Err(vst_lsp::LspError::Unsupported) => {
                return Ok(LspOutlineResponse::Unsupported { unsupported: true });
            }
            Err(e) => return Err(e.into()),
        };

        match resp {
            LspResponse::Outline(val) => Ok(parse_outline_response(val)),
            _ => Err(LspRouteError::Internal("Unexpected LSP response variant".to_string())),
        }
    }
}

pub fn symbol_kind_to_string(kind: u32) -> &'static str {
    match kind {
        1 => "file",
        2 => "module",
        3 => "namespace",
        4 => "package",
        5 => "class",
        6 => "method",
        7 => "property",
        8 => "field",
        9 => "constructor",
        10 => "enum",
        11 => "interface",
        12 => "function",
        13 => "variable",
        14 => "constant",
        15 => "string",
        16 => "number",
        17 => "boolean",
        18 => "array",
        19 => "object",
        20 => "key",
        21 => "null",
        22 => "enum_member",
        23 => "struct",
        24 => "event",
        25 => "operator",
        26 => "type_parameter",
        _ => "unknown",
    }
}

pub fn parse_outline_response(val: serde_json::Value) -> LspOutlineResponse {
    if val.is_null() {
        return LspOutlineResponse::Symbols {
            symbols: Vec::new(),
        };
    }

    let Some(arr) = val.as_array() else {
        return LspOutlineResponse::Symbols {
            symbols: Vec::new(),
        };
    };

    let mut symbols = Vec::new();
    for item in arr {
        if let Some(sym) = parse_document_symbol(item) {
            symbols.push(sym);
        }
    }
    // `textDocument/documentSymbol`'s response order is NOT guaranteed by the
    // LSP spec to match source order — some servers return declaration order,
    // others alphabetical or kind-grouped. The outline panel is meant to read
    // top-to-bottom like the file itself, so sort explicitly by position
    // rather than trusting whatever order the server happened to send.
    sort_symbols_by_position(&mut symbols);

    LspOutlineResponse::Symbols { symbols }
}

/// Sorts `symbols` by `(line, character)` ascending, recursively into each
/// symbol's `children` too (a class's methods can arrive out of order the
/// same way top-level symbols can).
fn sort_symbols_by_position(symbols: &mut [OutlineSymbol]) {
    symbols.sort_by_key(|s| (s.line, s.character));
    for sym in symbols.iter_mut() {
        sort_symbols_by_position(&mut sym.children);
    }
}

fn parse_document_symbol(item: &serde_json::Value) -> Option<OutlineSymbol> {
    let name = item.get("name")?.as_str()?.to_string();
    let kind_num = item.get("kind")?.as_u64()? as u32;
    let kind = symbol_kind_to_string(kind_num).to_string();

    let (line, character, end_line) = if let Some(range) = item.get("range") {
        let start = range.get("start")?;
        let end = range.get("end")?;
        let l = start.get("line")?.as_u64()? as u32;
        let c = start.get("character")?.as_u64()? as u32;
        let el = end.get("line")?.as_u64()? as u32;
        (l, c, el)
    } else if let Some(loc) = item.get("location") {
        let range = loc.get("range")?;
        let start = range.get("start")?;
        let end = range.get("end")?;
        let l = start.get("line")?.as_u64()? as u32;
        let c = start.get("character")?.as_u64()? as u32;
        let el = end.get("line")?.as_u64()? as u32;
        (l, c, el)
    } else {
        return None;
    };

    let mut children = Vec::new();
    if let Some(child_arr) = item.get("children").and_then(|v| v.as_array()) {
        for child_val in child_arr {
            if let Some(child_sym) = parse_document_symbol(child_val) {
                children.push(child_sym);
            }
        }
    }

    Some(OutlineSymbol {
        name,
        kind,
        line,
        character,
        end_line,
        children,
    })
}

pub fn parse_hover_response(val: serde_json::Value) -> LspHoverResponse {
    if val.is_null() {
        return LspHoverResponse::Empty { empty: true };
    }

    let contents = val.get("contents");
    let (signature, doc) = match contents {
        None => return LspHoverResponse::Empty { empty: true },
        Some(serde_json::Value::Null) => return LspHoverResponse::Empty { empty: true },
        Some(serde_json::Value::String(s)) => extract_signature_and_doc(s),
        Some(serde_json::Value::Object(map)) => {
            if let Some(serde_json::Value::String(value)) = map.get("value") {
                extract_signature_and_doc(value)
            } else {
                return LspHoverResponse::Empty { empty: true };
            }
        }
        Some(serde_json::Value::Array(arr)) => {
            if arr.is_empty() {
                return LspHoverResponse::Empty { empty: true };
            }
            let mut sig: Option<String> = None;
            let mut docs: Vec<String> = Vec::new();
            for item in arr {
                if let Some(s) = item.as_str() {
                    if sig.is_none() {
                        let (s_part, d_part) = extract_signature_and_doc(s);
                        sig = Some(s_part);
                        if let Some(d) = d_part {
                            docs.push(d);
                        }
                    } else {
                        docs.push(s.trim().to_string());
                    }
                } else if let Some(map) = item.as_object() {
                    if let Some(val) = map.get("value").and_then(|v| v.as_str()) {
                        if sig.is_none() {
                            sig = Some(val.trim().to_string());
                        } else {
                            docs.push(val.trim().to_string());
                        }
                    }
                }
            }
            let signature = sig.unwrap_or_default();
            if signature.is_empty() {
                return LspHoverResponse::Empty { empty: true };
            }
            let doc = if docs.is_empty() {
                None
            } else {
                Some(docs.join("\n\n").trim().to_string())
            };
            (signature, doc)
        }
        _ => return LspHoverResponse::Empty { empty: true },
    };

    if signature.trim().is_empty() {
        return LspHoverResponse::Empty { empty: true };
    }

    LspHoverResponse::Found { signature, doc }
}

fn extract_signature_and_doc(raw: &str) -> (String, Option<String>) {
    let raw = raw.trim();
    if raw.is_empty() {
        return (String::new(), None);
    }

    if let Some(start_fence) = raw.find("```") {
        let after_fence = &raw[start_fence + 3..];
        if let Some(first_newline) = after_fence.find('\n') {
            let code_content = &after_fence[first_newline + 1..];
            if let Some(end_fence) = code_content.find("```") {
                let signature = code_content[..end_fence].trim().to_string();
                let remaining = code_content[end_fence + 3..].trim();
                let doc_str = remaining
                    .strip_prefix("---")
                    .unwrap_or(remaining)
                    .trim();
                let doc = if doc_str.is_empty() {
                    None
                } else {
                    Some(doc_str.to_string())
                };
                return (signature, doc);
            }
        }
    }

    let mut parts = raw.splitn(2, "\n\n");
    let first = parts.next().unwrap_or("").trim().to_string();
    let rest = parts.next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    (first, rest)
}
