use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::http::StatusCode;
use axum::Json;
use serde_json::json;
use vst_git::paths::Paths;
use vst_lsp::{LspError, LspManager, LspRequestKind, LspResponse, WorkspaceKey};
use vst_store::StoreHandle;
use vst_types::domain::ProjectRecord;
use vst_types::rest::lsp::{
    Location, LspDefinitionResponse, LspFailure, LspFallback, LspFallbackReason, LspFileRef,
    LspHoverResponse, LspLanguageStatus, LspLanguageSurveyResponse, LspOutlineResponse,
    LspReferencesResponse, LspStatus, LspStatusPresentation, LspStatusResponse, OutlineSymbol,
    ReferenceEntry, ReferenceGroup,
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
    /// The language server failed to start (latched); nothing to fall back to.
    #[error("{}", .0.summary)]
    Failed(Box<LspFailure>),
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
            LspError::Failed(failure) => LspRouteError::Failed(failure),
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
            crate::search_util::RgSearchError::ProcessError(msg) => LspRouteError::Internal(msg),
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

/// The workspace root as the language server sees it. Servers report
/// canonical (symlink-resolved) paths, so comparing them against a
/// non-canonical root classified in-workspace hits as external whenever the
/// project path went through a symlink.
fn canonical_root(root: &Path) -> PathBuf {
    root.canonicalize().unwrap_or_else(|_| root.to_path_buf())
}

/// Workspace-relative path of `abs` when it lives under the workspace root
/// (checked against both the canonical and the configured root), else `None`.
fn workspace_relative(abs: &Path, root: &Path, canon_root: &Path) -> Option<String> {
    abs.strip_prefix(canon_root)
        .or_else(|_| abs.strip_prefix(root))
        .ok()
        .map(|rel| rel.to_string_lossy().into_owned())
}

/// One ripgrep whole-word hit, normalised to the same shape as an LSP location:
/// raw line without its terminator, UTF-16 start/end columns into it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TextHit {
    rel_path: String,
    line: u32,
    character: u32,
    end_character: u32,
    preview: String,
}

impl TextHit {
    fn from_rg(m: crate::search_util::RgRawMatch) -> Self {
        let preview = m.line_text.trim_end_matches(['\n', '\r']).to_string();
        let character = vst_lsp::byte_offset_to_utf16_col(&preview, m.start_byte);
        let end_character = vst_lsp::byte_offset_to_utf16_col(&preview, m.end_byte);
        Self {
            rel_path: m.path.strip_prefix("./").unwrap_or(&m.path).to_string(),
            line: m.line_number.saturating_sub(1),
            character,
            end_character,
            preview,
        }
    }
}

/// Dependency / build-output directories excluded from the text fallback.
/// ripgrep already honours `.gitignore`, but plenty of checkouts (e.g. a
/// bare `npm install` without an ignore file) don't list these.
const TEXT_FALLBACK_EXCLUDES: &[&str] = &[
    "!node_modules",
    "!vendor",
    "!target",
    "!.venv",
    "!__pycache__",
];

/// Text-search fallback used while no language server answer is available.
async fn text_search_hits(
    root: &Path,
    word: &str,
    limit: usize,
) -> Result<Vec<TextHit>, LspRouteError> {
    let raw = crate::search_util::rg_search_with_globs(
        root,
        word,
        false,
        true,
        true,
        TEXT_FALLBACK_EXCLUDES,
        limit,
    )
    .await?;
    Ok(raw.into_iter().map(TextHit::from_rg).collect())
}

/// Why the daemon may substitute text search for the language server — `None`
/// for errors that must surface as-is (timeouts, server errors, …).
fn fallback_reason(e: &LspError) -> Option<LspFallbackReason> {
    match e {
        LspError::Disabled => Some(LspFallbackReason::Disabled),
        LspError::Starting => Some(LspFallbackReason::Starting),
        LspError::NotFound => Some(LspFallbackReason::NotFound),
        LspError::Unsupported => Some(LspFallbackReason::Unsupported),
        LspError::Failed(_) => Some(LspFallbackReason::ServerFailed),
        _ => None,
    }
}

/// Whether to answer with text matches for `reason`. A server that has been
/// ready before normally surfaces its errors as-is (a transient `Starting`
/// after a restart shouldn't swap real results for text hits), but a latched
/// start failure has no server answer to wait for — substitute regardless.
fn substitute_text_fallback(reason: LspFallbackReason, has_ever_been_ready: bool) -> bool {
    reason == LspFallbackReason::ServerFailed || !has_ever_been_ready
}

/// Status presentation: a latched failure gets `describe_failure`, anything
/// else the plain per-status `describe`.
fn present(
    status: LspStatus,
    language: Option<&str>,
    failure: Option<&LspFailure>,
) -> LspStatusPresentation {
    match failure {
        Some(f) => vst_lsp::status::describe_failure(f, language),
        None => vst_lsp::status::describe(status, language),
    }
}

/// Keywords that introduce a declaration across the languages we serve.
const DECLARATION_KEYWORDS: &[&str] = &[
    "fn",
    "function",
    "class",
    "struct",
    "enum",
    "trait",
    "type",
    "interface",
    "const",
    "let",
    "var",
    "def",
    "func",
    "mod",
    "module",
    "namespace",
    "macro_rules!",
];

/// Heuristic: does the occurrence at UTF-16 column `character` look like the
/// symbol's declaration? True when the text right before it is a declaration
/// keyword followed only by identifier-ish modifiers (`pub fn x`, `export
/// default class X`, `let mut x`, `pub(crate) struct X`) — so `x = foo`,
/// `import { foo }` and `foo(bar)` don't count.
fn is_declaration_like(line: &str, character: u32) -> bool {
    let prefix = &line[..vst_lsp::utf16_col_to_byte_offset(line, character)];
    let is_ident = |c: char| c.is_alphanumeric() || c == '_' || c == '!';
    let mut rest = prefix.trim_end();
    // Walk words right-to-left until a keyword (yes) or punctuation (no).
    while let Some(last) = rest.chars().last() {
        if !is_ident(last) {
            return false;
        }
        let word_start = rest
            .char_indices()
            .rev()
            .take_while(|&(_, c)| is_ident(c))
            .last()
            .map(|(i, _)| i)
            .unwrap_or(0);
        if DECLARATION_KEYWORDS.contains(&&rest[word_start..]) {
            return true;
        }
        rest = rest[..word_start].trim_end();
    }
    false
}

/// Shapes text hits into a definition fallback: drops the occurrence the user
/// clicked when it's a usage (a usage is never its own definition), puts
/// declaration-like lines first (stable otherwise), then caps at `limit`.
///
/// A clicked occurrence that itself looks like the declaration is kept: that
/// mirrors a real server, which answers "definition of the name I'm on" with
/// the name itself — the UI's self-definition handling depends on it.
fn rank_definition_hits(
    hits: Vec<TextHit>,
    clicked: Option<(&str, u32, u32)>,
    limit: usize,
) -> Vec<TextHit> {
    let mut hits: Vec<TextHit> = hits
        .into_iter()
        .filter(|h| match clicked {
            Some((path, line, character)) => {
                let is_clicked = h.rel_path == path
                    && h.line == line
                    && h.character <= character
                    && character < h.end_character;
                !is_clicked || is_declaration_like(&h.preview, h.character)
            }
            None => true,
        })
        .collect();
    hits.sort_by_key(|h| !is_declaration_like(&h.preview, h.character));
    hits.truncate(limit);
    hits
}

pub fn lsp_err_to_response(err: LspRouteError) -> (StatusCode, Json<serde_json::Value>) {
    match err {
        LspRouteError::NotFound(msg) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": msg, "code": "NOT_FOUND" })),
        ),
        LspRouteError::ExternalTokenExpired => (
            StatusCode::NOT_FOUND,
            Json(
                json!({ "error": "External token expired", "code": "LSP_EXTERNAL_TOKEN_EXPIRED" }),
            ),
        ),
        LspRouteError::NotReady(msg) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": msg, "code": "LSP_NOT_READY" })),
        ),
        LspRouteError::Disabled => (
            StatusCode::CONFLICT,
            Json(
                json!({ "error": "Code navigation is disabled for this workspace", "code": "LSP_DISABLED" }),
            ),
        ),
        LspRouteError::Unsupported(msg) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": msg, "code": "LSP_UNSUPPORTED" })),
        ),
        LspRouteError::ServerError(msg) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": msg, "code": "LSP_SERVER_ERROR" })),
        ),
        LspRouteError::Failed(failure) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": failure.summary,
                "code": "LSP_SERVER_FAILED",
                "failure": *failure,
            })),
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

    async fn find_project_for_worktree(&self, wt_id: &str) -> Result<ProjectRecord, LspRouteError> {
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
                    .ok_or_else(|| {
                        LspRouteError::NotFound(format!("Worktree '{worktree_id}' not found"))
                    })?;
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
        let (status, language, failure) = self
            .lsp_manager
            .status_with_failure(&workspace, path, enabled)
            .await;
        let presentation = present(status, language.as_deref(), failure.as_ref());
        // Only meaningful while the server is up; `degraded_info()` already
        // returns `None` for a dead/stopped handle, and a disabled workspace
        // must not report a stale message from before it was disabled.
        // Never alongside `failure` ("up but impaired" vs "not up").
        let degraded = if enabled && failure.is_none() {
            self.lsp_manager.degraded_info(&workspace, path).await
        } else {
            None
        };
        Ok(LspStatusResponse {
            status,
            language,
            presentation,
            degraded,
            failure,
        })
    }

    /// `POST …/lsp/restart`: clears a latched failure for `language` and
    /// respawns its server now (no-op while LSP is disabled), then reports
    /// the resulting status for that language.
    pub async fn restart(
        &self,
        workspace: WorkspaceKey,
        language: &str,
    ) -> Result<LspStatusResponse, LspRouteError> {
        let root = self.resolve_workspace_root(&workspace).await?;
        let enabled = self.is_lsp_enabled(&workspace).await?;
        let cfg = vst_lsp::lookup_by_language(language).ok_or_else(|| {
            LspRouteError::Unsupported(format!("Unsupported language: {language}"))
        })?;
        if enabled {
            self.lsp_manager
                .restart(&workspace, &root, cfg.language)
                .await?;
        }
        let ext = cfg.extensions.first().copied().unwrap_or(cfg.language);
        self.status(workspace, &format!("_.{ext}")).await
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
    ) -> Result<Vec<LspLanguageStatus>, LspRouteError> {
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
            let Some(cfg) = vst_lsp::lookup_by_language(lang) else {
                continue;
            };
            let Some(ext) = cfg.extensions.first() else {
                continue;
            };
            let synthetic_path = format!("_.{ext}");
            let (status, resolved_language, failure) = self
                .lsp_manager
                .status_with_failure(&workspace, &synthetic_path, enabled)
                .await;
            let presentation = present(status, resolved_language.as_deref(), failure.as_ref());
            out.push(LspLanguageStatus {
                language: lang.to_string(),
                status,
                presentation,
                failure,
            });
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
            LspFileRef::Workspace { path } => vst_lsp::resolve_workspace_path(&root, path)?,
            LspFileRef::External { token } => self
                .lsp_manager
                .resolve_external_token(&workspace, token)
                .await
                .ok_or(LspRouteError::ExternalTokenExpired)?,
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
                let reason = match fallback_reason(&e) {
                    Some(r)
                        if substitute_text_fallback(
                            r,
                            self.lsp_manager.has_ever_been_ready(&workspace, lang).await,
                        ) =>
                    {
                        Some(r)
                    }
                    _ => None,
                };
                if let Some(reason) = reason {
                    let word_opt = if let Ok(content) = tokio::fs::read_to_string(&abs_path).await {
                        extract_word_at_pos(&content, line, character)
                    } else {
                        None
                    };

                    if let Some(word_text) = word_opt {
                        // Over-fetch so a declaration past the first 50 usages
                        // still makes the cut after ranking.
                        let hits = text_search_hits(&root, &word_text, 200).await?;
                        let clicked_rel =
                            workspace_relative(&abs_path, &root, &canonical_root(&root));
                        let hits = rank_definition_hits(
                            hits,
                            clicked_rel.as_deref().map(|p| (p, line, character)),
                            50,
                        );
                        let locations = hits
                            .into_iter()
                            .map(|h| Location {
                                line: h.line,
                                character: h.character,
                                end_character: Some(h.end_character),
                                preview: h.preview,
                                confidence: "text".into(),
                                external: false,
                                path: Some(h.rel_path),
                                token: None,
                                display_path: None,
                            })
                            .collect();

                        return Ok(LspDefinitionResponse {
                            locations,
                            fallback: Some(LspFallback { reason }),
                        });
                    }
                }
                return Err(e.into());
            }
        };

        match resp {
            LspResponse::Definition(locs) => {
                let canon_root = canonical_root(&root);
                let mut locations = Vec::new();
                for loc in locs {
                    if let Some(rel) = workspace_relative(&loc.abs_path, &root, &canon_root) {
                        locations.push(Location {
                            line: loc.line,
                            character: loc.character,
                            end_character: loc.end_character,
                            preview: loc.preview,
                            external: false,
                            path: Some(rel),
                            token: None,
                            display_path: None,
                            confidence: "lsp".into(),
                        });
                    } else {
                        let mut token = None;
                        let mut display_path = None;
                        if let Ok(canon) = loc.abs_path.canonicalize() {
                            if canon.is_file()
                                && !vst_lsp::is_sensitive_path(&canon, Some(self.paths.vst_home()))
                            {
                                let t = self
                                    .lsp_manager
                                    .get_or_mint_external_token(&workspace, &canon)
                                    .await;
                                display_path = Some(canon.to_string_lossy().to_string());
                                token = Some(t);
                            }
                        }
                        locations.push(Location {
                            line: loc.line,
                            character: loc.character,
                            end_character: loc.end_character,
                            preview: loc.preview,
                            external: true,
                            path: None,
                            token,
                            display_path,
                            confidence: "lsp".into(),
                        });
                    }
                }
                Ok(LspDefinitionResponse {
                    locations,
                    fallback: None,
                })
            }
            _ => Err(LspRouteError::Internal(
                "Unexpected LSP response variant".to_string(),
            )),
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
            _ => Err(LspRouteError::Internal(
                "Unexpected LSP response variant".to_string(),
            )),
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
            LspFileRef::Workspace { path } => vst_lsp::resolve_workspace_path(&root, path)?,
            LspFileRef::External { token } => self
                .lsp_manager
                .resolve_external_token(&workspace, token)
                .await
                .ok_or(LspRouteError::ExternalTokenExpired)?,
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
                let reason = match fallback_reason(&e) {
                    Some(r)
                        if substitute_text_fallback(
                            r,
                            self.lsp_manager.has_ever_been_ready(&workspace, lang).await,
                        ) =>
                    {
                        Some(r)
                    }
                    _ => None,
                };
                if let Some(reason) = reason {
                    let word_opt = if let Ok(content) = tokio::fs::read_to_string(&abs_path).await {
                        extract_word_at_pos(&content, line, character)
                    } else {
                        None
                    };

                    if let Some(word_text) = word_opt {
                        let hits = text_search_hits(&root, &word_text, 50).await?;

                        let mut groups: Vec<ReferenceGroup> = Vec::new();
                        let mut file_indices: HashMap<String, usize> = HashMap::new();

                        for h in hits {
                            let rel = h.rel_path;
                            let entry = ReferenceEntry {
                                line: h.line,
                                character: h.character,
                                end_character: Some(h.end_character),
                                preview: h.preview,
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
                            fallback: Some(LspFallback { reason }),
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
                        fallback: None,
                    });
                }

                let end = (offset + 50).min(n);
                let page_targets = if n == 0 {
                    &[][..]
                } else {
                    &targets[offset..end]
                };
                let has_more = end < n;
                let next_cursor = if has_more {
                    Some(end.to_string())
                } else {
                    None
                };

                let canon_root = canonical_root(&root);
                let mut groups: Vec<ReferenceGroup> = Vec::new();
                let mut file_indices: HashMap<PathBuf, usize> = HashMap::new();

                for target in page_targets {
                    let entry = ReferenceEntry {
                        line: target.line,
                        character: target.character,
                        end_character: target.end_character,
                        preview: target.preview.clone(),
                        is_declaration: target.is_declaration,
                        confidence: "lsp".into(),
                    };

                    if let Some(&idx) = file_indices.get(&target.abs_path) {
                        groups[idx].entries.push(entry);
                    } else {
                        let rel = workspace_relative(&target.abs_path, &root, &canon_root);
                        let group = if let Some(rel) = rel {
                            ReferenceGroup {
                                path: Some(rel),
                                external: false,
                                token: None,
                                display_path: None,
                                entries: vec![entry],
                            }
                        } else {
                            let mut token = None;
                            let mut display_path = None;
                            if let Ok(canon) = target.abs_path.canonicalize() {
                                if canon.is_file()
                                    && !vst_lsp::is_sensitive_path(
                                        &canon,
                                        Some(self.paths.vst_home()),
                                    )
                                {
                                    let t = self
                                        .lsp_manager
                                        .get_or_mint_external_token(&workspace, &canon)
                                        .await;
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
                    fallback: None,
                })
            }
            _ => Err(LspRouteError::Internal(
                "Unexpected LSP response variant".to_string(),
            )),
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
            LspFileRef::Workspace { path: file_param }
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
            _ => Err(LspRouteError::Internal(
                "Unexpected LSP response variant".to_string(),
            )),
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

    // `DocumentSymbol` form: `range` spans the whole symbol INCLUDING doc
    // comments and attributes, `selectionRange` is just the name. Jump/colour
    // targets use the name; `range` is kept only for containment. The flat
    // `SymbolInformation` form has a single `location.range`.
    let range = item
        .get("range")
        .or_else(|| item.get("location").and_then(|loc| loc.get("range")))?;
    let range_start = range.get("start")?;
    let range_start_line = range_start.get("line")?.as_u64()? as u32;
    let end_line = range.get("end")?.get("line")?.as_u64()? as u32;
    let name_start = item
        .get("selectionRange")
        .and_then(|sel| sel.get("start"))
        .unwrap_or(range_start);
    let line = name_start.get("line")?.as_u64()? as u32;
    let character = name_start.get("character")?.as_u64()? as u32;

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
        range_start_line,
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

/// Splits `text` at the first markdown horizontal rule (a line that is just
/// `---`), returning the text before and after it.
fn split_at_rule(text: &str) -> Option<(&str, &str)> {
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        if line.trim() == "---" {
            return Some((&text[..offset], &text[offset + line.len()..]));
        }
        offset += line.len();
    }
    None
}

/// Splits markdown hover contents into `(signature, doc)`.
///
/// The signature is the LAST fenced code block before the first `---` rule.
/// rust-analyzer sends the container path first (```` ```rust
/// vst_daemon::network``` ````) and the real signature second, so taking the
/// first block showed the module path as the "signature" and pushed the actual
/// signature into the doc. Earlier blocks (the container) become the doc's
/// leading line(s); prose and everything after the rule follow.
fn extract_signature_and_doc(raw: &str) -> (String, Option<String>) {
    let raw = raw.trim();
    if raw.is_empty() {
        return (String::new(), None);
    }

    let mut fences: Vec<&str> = Vec::new();
    let mut prose: Vec<&str> = Vec::new();
    let mut tail: Option<&str> = None;
    let mut rest = raw;
    loop {
        let fence_at = rest.find("```");
        let before = &rest[..fence_at.unwrap_or(rest.len())];
        if let Some((pre, post)) = split_at_rule(before) {
            prose.push(pre);
            // `post` ends where `before` does; the tail runs on through `rest`.
            tail = Some(&rest[before.len() - post.len()..]);
            break;
        }
        let Some(i) = fence_at else {
            prose.push(rest);
            break;
        };
        prose.push(before);
        let after_ticks = &rest[i + 3..];
        // Skip the info string (` ```rust `); an unterminated fence is prose.
        let Some(code) = after_ticks.find('\n').map(|nl| &after_ticks[nl + 1..]) else {
            prose.push(&rest[i..]);
            break;
        };
        let Some(end) = code.find("```") else {
            prose.push(&rest[i..]);
            break;
        };
        fences.push(&code[..end]);
        rest = &code[end + 3..];
    }

    let Some((signature, containers)) = fences.split_last() else {
        let mut parts = raw.splitn(2, "\n\n");
        let first = parts.next().unwrap_or("").trim().to_string();
        let rest = parts
            .next()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        return (first, rest);
    };

    let doc_parts: Vec<&str> = containers
        .iter()
        .chain(prose.iter())
        .chain(tail.iter())
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    let doc = if doc_parts.is_empty() {
        None
    } else {
        Some(doc_parts.join("\n\n"))
    };
    (signature.trim().to_string(), doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search_util::RgRawMatch;

    fn hit(path: &str, line: u32, text: &str, word: &str) -> TextHit {
        TextHit::from_rg(rg(path, line + 1, text, word))
    }

    #[test]
    fn declaration_like_lines() {
        let decl = |line: &str, word: &str| {
            let col = vst_lsp::byte_offset_to_utf16_col(line, line.find(word).unwrap());
            is_declaration_like(line, col)
        };
        assert!(decl("pub fn subscribe(&self) {", "subscribe"));
        assert!(decl("pub(crate) struct NetworkControl {", "NetworkControl"));
        assert!(decl("export default class Foo {}", "Foo"));
        assert!(decl(
            "export async function registerRoutes(app) {",
            "registerRoutes"
        ));
        assert!(decl("    let mut count = 0;", "count"));
        assert!(decl("def handler(event):", "handler"));
        assert!(decl("type Id = string;", "Id"));
        assert!(decl("macro_rules! my_macro {", "my_macro"));
        assert!(decl("// — const ünï = 1", "ünï"));

        assert!(!decl(
            "import { registerRoutes } from './routes';",
            "registerRoutes"
        ));
        assert!(!decl("    registerRoutes(app);", "registerRoutes"));
        assert!(!decl("const app = registerRoutes(x);", "registerRoutes"));
        assert!(!decl("use tokio::sync::oneshot;", "oneshot"));
        assert!(!decl("fn run(ctl: NetworkControl) {}", "NetworkControl"));
        assert!(!decl("registerRoutes", "registerRoutes"));
    }

    #[test]
    fn definition_hits_drop_clicked_usage_and_rank_declarations_first() {
        let hits = vec![
            hit(
                "src/server.ts",
                1,
                "import { registerRoutes } from './routes';",
                "registerRoutes",
            ),
            hit(
                "src/server.ts",
                9,
                "  registerRoutes(app);",
                "registerRoutes",
            ),
            hit(
                "docs/notes.md",
                0,
                "call registerRoutes first",
                "registerRoutes",
            ),
            hit(
                "src/routes.ts",
                4,
                "export function registerRoutes(app) {",
                "registerRoutes",
            ),
        ];
        // Clicked mid-identifier on the server.ts:9 usage.
        let out = rank_definition_hits(hits, Some(("src/server.ts", 9, 6)), 50);
        let got: Vec<(&str, u32)> = out.iter().map(|h| (h.rel_path.as_str(), h.line)).collect();
        assert_eq!(
            got,
            [
                ("src/routes.ts", 4),
                ("src/server.ts", 1),
                ("docs/notes.md", 0)
            ]
        );
    }

    #[test]
    fn definition_hits_keep_clicked_declaration_and_respect_limit() {
        let hits = vec![
            hit("a.rs", 0, "pub fn internal() {}", "internal"),
            hit("b.rs", 3, "    internal();", "internal"),
            hit("c.rs", 3, "    internal();", "internal"),
        ];
        let out = rank_definition_hits(hits, Some(("a.rs", 0, 7)), 2);
        let got: Vec<&str> = out.iter().map(|h| h.rel_path.as_str()).collect();
        assert_eq!(got, ["a.rs", "b.rs"]);
    }

    #[test]
    fn fallback_reason_only_for_substitutable_errors() {
        assert_eq!(
            fallback_reason(&LspError::Disabled),
            Some(LspFallbackReason::Disabled)
        );
        assert_eq!(
            fallback_reason(&LspError::Starting),
            Some(LspFallbackReason::Starting)
        );
        assert_eq!(
            fallback_reason(&LspError::NotFound),
            Some(LspFallbackReason::NotFound)
        );
        assert_eq!(
            fallback_reason(&LspError::Unsupported),
            Some(LspFallbackReason::Unsupported)
        );
        assert_eq!(
            fallback_reason(&LspError::Failed(Box::new(sample_failure()))),
            Some(LspFallbackReason::ServerFailed)
        );
        assert_eq!(fallback_reason(&LspError::Timeout), None);
        assert_eq!(fallback_reason(&LspError::ServerError("x".into())), None);
        assert_eq!(fallback_reason(&LspError::ProcessDied), None);
    }

    fn sample_failure() -> LspFailure {
        use vst_types::rest::lsp::{LspFailureKind, LspRemediation, LspRemediationKind};
        LspFailure {
            kind: LspFailureKind::MissingDependency,
            summary: "TypeScript isn't installed for this project — code navigation needs it."
                .into(),
            message: Some("Could not find a valid TypeScript installation".into()),
            exit_code: None,
            remediation: vec![LspRemediation {
                kind: LspRemediationKind::Retry,
                label: "Retry".into(),
                command: None,
            }],
            auto_retry: true,
        }
    }

    #[test]
    fn server_failed_substitutes_even_after_ready() {
        assert!(substitute_text_fallback(
            LspFallbackReason::ServerFailed,
            true
        ));
        assert!(substitute_text_fallback(
            LspFallbackReason::ServerFailed,
            false
        ));
        assert!(!substitute_text_fallback(LspFallbackReason::Starting, true));
        assert!(substitute_text_fallback(LspFallbackReason::Starting, false));
    }

    #[test]
    fn failed_maps_to_503_with_failure_body() {
        let (code, Json(body)) = lsp_err_to_response(LspRouteError::from(LspError::Failed(
            Box::new(sample_failure()),
        )));
        assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["code"], "LSP_SERVER_FAILED");
        assert_eq!(body["error"], sample_failure().summary);
        assert_eq!(body["failure"]["kind"], "missing_dependency");
        assert_eq!(body["failure"]["summary"], sample_failure().summary);
        assert_eq!(body["failure"]["autoRetry"], true);
        assert_eq!(body["failure"]["remediation"][0]["kind"], "retry");
        // Never the misleading old wording.
        assert!(!body.to_string().contains("process died"));
    }

    #[test]
    fn fallback_serializes_to_contract_shape() {
        let resp = LspDefinitionResponse {
            locations: vec![],
            fallback: Some(LspFallback {
                reason: LspFallbackReason::NotFound,
            }),
        };
        assert_eq!(
            serde_json::to_value(&resp).unwrap(),
            serde_json::json!({ "locations": [], "fallback": { "reason": "not_found" } })
        );
    }

    #[test]
    fn hover_signature_is_last_fenced_block_before_rule() {
        // rust-analyzer's hover for `NetworkControl` in network.rs.
        let raw = "```rust\nvst_daemon::network\n```\n\n```rust\npub struct NetworkControl {\n    tx: Sender,\n}\n```\n\n---\n\nControls the network.\n\n```rust\nlet n = NetworkControl::new();\n```";
        let (sig, doc) = extract_signature_and_doc(raw);
        assert_eq!(sig, "pub struct NetworkControl {\n    tx: Sender,\n}");
        assert_eq!(
            doc.as_deref(),
            Some("vst_daemon::network\n\nControls the network.\n\n```rust\nlet n = NetworkControl::new();\n```")
        );
    }

    #[test]
    fn hover_single_block_unchanged() {
        let (sig, doc) = extract_signature_and_doc(
            "```rust\npub fn run(cfg: Config) -> Result<(), Error>\n```\n\n---\n\nRuns the app.",
        );
        assert_eq!(sig, "pub fn run(cfg: Config) -> Result<(), Error>");
        assert_eq!(doc.as_deref(), Some("Runs the app."));

        let (sig, doc) = extract_signature_and_doc("```ts\nconst x: number\n```");
        assert_eq!(sig, "const x: number");
        assert_eq!(doc, None);
    }

    #[test]
    fn hover_without_fences_or_with_unterminated_fence() {
        let (sig, doc) = extract_signature_and_doc("plain sig\n\nsome docs");
        assert_eq!(
            (sig.as_str(), doc.as_deref()),
            ("plain sig", Some("some docs"))
        );

        // A fence opened after the rule never counts as the signature.
        let (sig, doc) = extract_signature_and_doc("```py\ndef f()\n```\n---\n```py\nunterminated");
        assert_eq!(sig, "def f()");
        assert_eq!(doc.as_deref(), Some("```py\nunterminated"));
    }

    fn symbols(res: LspOutlineResponse) -> Vec<OutlineSymbol> {
        match res {
            LspOutlineResponse::Symbols { symbols } => symbols,
            _ => panic!("expected symbols"),
        }
    }

    #[test]
    fn outline_uses_selection_range_for_name_and_range_for_containment() {
        // Shape of rust-analyzer's `subscribe` in network.rs: a `///` doc
        // comment on 84, the name on 85.
        let syms = symbols(parse_outline_response(serde_json::json!([{
            "name": "subscribe",
            "kind": 6,
            "range": { "start": { "line": 84, "character": 4 }, "end": { "line": 87, "character": 5 } },
            "selectionRange": { "start": { "line": 85, "character": 11 }, "end": { "line": 85, "character": 20 } }
        }])));
        assert_eq!((syms[0].line, syms[0].character), (85, 11));
        assert_eq!(syms[0].range_start_line, 84);
        assert_eq!(syms[0].end_line, 87);
    }

    #[test]
    fn outline_falls_back_to_range_without_selection_range() {
        let syms = symbols(parse_outline_response(serde_json::json!([
            {
                "name": "plain",
                "kind": 12,
                "range": { "start": { "line": 3, "character": 2 }, "end": { "line": 9, "character": 1 } }
            },
            {
                "name": "flat",
                "kind": 13,
                "location": {
                    "uri": "file:///x.ts",
                    "range": { "start": { "line": 12, "character": 6 }, "end": { "line": 12, "character": 20 } }
                }
            }
        ])));
        assert_eq!(
            (syms[0].line, syms[0].character, syms[0].range_start_line),
            (3, 2, 3)
        );
        assert_eq!(
            (syms[1].line, syms[1].character, syms[1].range_start_line),
            (12, 6, 12)
        );
        assert_eq!(syms[1].end_line, 12);
    }

    #[test]
    fn outline_sorts_by_name_position() {
        // A heavily documented symbol whose range starts earlier but whose
        // name comes after a sibling's must still sort by the name line.
        let syms = symbols(parse_outline_response(serde_json::json!([
            {
                "name": "b",
                "kind": 12,
                "range": { "start": { "line": 10, "character": 0 }, "end": { "line": 20, "character": 1 } },
                "selectionRange": { "start": { "line": 15, "character": 7 }, "end": { "line": 15, "character": 8 } }
            },
            {
                "name": "a",
                "kind": 12,
                "range": { "start": { "line": 2, "character": 0 }, "end": { "line": 8, "character": 1 } },
                "selectionRange": { "start": { "line": 2, "character": 3 }, "end": { "line": 2, "character": 4 } }
            }
        ])));
        let names: Vec<&str> = syms.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["a", "b"]);
    }

    fn rg(path: &str, line_number: u32, line_text: &str, word: &str) -> RgRawMatch {
        let start_byte = line_text.find(word).unwrap();
        RgRawMatch {
            path: path.to_string(),
            line_number,
            start_byte,
            end_byte: start_byte + word.len(),
            line_text: line_text.to_string(),
        }
    }

    #[test]
    fn text_hit_keeps_indent_and_strips_terminator() {
        let hit = TextHit::from_rg(rg(
            "./src/a.ts",
            3,
            "    registerRoutes(app);\r\n",
            "registerRoutes",
        ));
        assert_eq!(hit.preview, "    registerRoutes(app);");
        assert_eq!(hit.rel_path, "src/a.ts");
        assert_eq!(hit.line, 2);
        assert_eq!((hit.character, hit.end_character), (4, 18));
        assert_eq!(
            &hit.preview[hit.character as usize..hit.end_character as usize],
            "registerRoutes"
        );
    }

    #[test]
    fn text_hit_columns_are_utf16() {
        // `—` is 3 UTF-8 bytes but one UTF-16 unit; 🦀 is 4 bytes / 2 units.
        let hit = TextHit::from_rg(rg("a.rs", 1, "// — 🦀 foo\n", "foo"));
        assert_eq!((hit.character, hit.end_character), (8, 11));
    }

    #[test]
    fn workspace_relative_accepts_canonical_paths_under_a_symlinked_root() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir_all(real.join("src")).unwrap();
        std::fs::write(real.join("src/lib.rs"), "").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let canon_root = canonical_root(&link);
        let server_path = real.join("src/lib.rs").canonicalize().unwrap();
        assert_eq!(
            workspace_relative(&server_path, &link, &canon_root).as_deref(),
            Some("src/lib.rs")
        );
        // The non-canonical root alone would have classified it as external.
        assert!(!server_path.starts_with(&link));
        // A non-canonical path under the configured root still works.
        assert_eq!(
            workspace_relative(&link.join("src/lib.rs"), &link, &canon_root).as_deref(),
            Some("src/lib.rs")
        );
        assert_eq!(
            workspace_relative(Path::new("/usr/lib/x.rs"), &link, &canon_root),
            None
        );
    }
}
