//! `routes/attachments.ts` — Attachment upload and delete route.
//!
//! Ports `daemon/src/routes/attachments.ts` (237 LOC):
//! - `POST /sessions/:id/attachments`
//! - `DELETE /sessions/:id/attachments/:uploadId`
//!
//! Saves files under `<sessionDataDir>/uploads/<uploadId>/<sanitized name>`.
//! Traversal is rejected, filenames sanitized, files size-capped (20MB).
//! For terminal-channel (non-json) agent sessions, also writes a pending-upload
//! reference file into `<checkout>/.vibe-station/pending-uploads/<sessionId>/<uploadId>-<name>`.

use std::path::{Path, PathBuf};
use vst_git::paths::Paths;
use vst_lifecycle::channel::session_channel;
use vst_store::StoreHandle;
use vst_types::domain::{Attachment, Channel, ProjectRecord, SessionType, WorktreeRecord};
use vst_types::rest::attachments::{AttachmentsResult, DeleteAttachmentResult};
use vst_ws::state::attachment_registry::AttachmentRegistry;

use crate::sessions::{find_session_context, SessionContext};

pub const MAX_FILE_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_BODY_BYTES: usize = 25 * 1024 * 1024;

/// Input file part for uploading attachments.
#[derive(Clone, Debug)]
pub struct UploadPart {
    pub filename: String,
    pub content_type: Option<String>,
    pub data: Vec<u8>,
}

/// Errors surfaced by attachment routes.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AttachmentRouteError {
    #[error("not_found: session '{0}' not found")]
    SessionNotFound(String),
    #[error("validation_error: session '{0}' is not an agent session")]
    NotAgentSession(String),
    #[error("validation_error: no files provided")]
    NoFilesProvided,
    #[error("payload_too_large: file '{0}' exceeds {MAX_FILE_BYTES} bytes")]
    FileTooLarge(String),
    #[error("validation_error: invalid filename '{0}'")]
    InvalidFilename(String),
    #[error("not_found: upload '{0}' not found")]
    UploadNotFound(String),
    #[error("internal_error: {0}")]
    Internal(String),
}

impl AttachmentRouteError {
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::SessionNotFound(_) | Self::UploadNotFound(_) => "not_found",
            Self::NotAgentSession(_) | Self::NoFilesProvided | Self::InvalidFilename(_) => {
                "validation_error"
            }
            Self::FileTooLarge(_) => "payload_too_large",
            Self::Internal(_) => "internal_error",
        }
    }
}

/// Sanitize an uploaded filename: strip any path components, reject traversal / empty names.
pub fn sanitize_filename(raw: &str) -> Option<String> {
    let normalized = raw.replace('\\', "/");
    let base = Path::new(&normalized)
        .file_name()
        .and_then(|f| f.to_str())?;
    let trimmed = base.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\0')
    {
        return None;
    }
    // Cap length to 255 chars
    let capped = if trimmed.len() > 255 {
        trimmed[..255].to_string()
    } else {
        trimmed.to_string()
    };
    Some(capped)
}

/// Absolute checkout path a session runs against.
pub fn checkout_path_for(
    paths: &Paths,
    project: &ProjectRecord,
    worktree: Option<&WorktreeRecord>,
) -> PathBuf {
    match worktree {
        Some(wt) => paths.worktree_path(&project.id, &wt.id),
        None => PathBuf::from(&project.absolute_path),
    }
}

/// Pending upload ref path: `<checkout>/.vibe-station/pending-uploads/<sessionId>/<uploadId>-<name>`.
pub fn pending_upload_ref_path(
    paths: &Paths,
    project: &ProjectRecord,
    worktree: Option<&WorktreeRecord>,
    session_id: &str,
    upload_id: &str,
    name: &str,
) -> PathBuf {
    checkout_path_for(paths, project, worktree)
        .join(".vibe-station")
        .join("pending-uploads")
        .join(session_id)
        .join(format!("{upload_id}-{name}"))
}

/// Handler for attachment endpoints.
#[derive(Clone)]
pub struct AttachmentRoutes {
    pub store: StoreHandle,
    pub paths: Paths,
    pub attachment_registry: AttachmentRegistry,
}

impl AttachmentRoutes {
    pub fn new(store: StoreHandle, paths: Paths, attachment_registry: AttachmentRegistry) -> Self {
        Self {
            store,
            paths,
            attachment_registry,
        }
    }

    /// `POST /sessions/:id/attachments`
    pub async fn upload_attachments(
        &self,
        session_id: &str,
        parts: Vec<UploadPart>,
    ) -> Result<AttachmentsResult, AttachmentRouteError> {
        let ctx = find_session_context(&self.store, session_id)
            .await
            .ok_or_else(|| AttachmentRouteError::SessionNotFound(session_id.to_string()))?;

        let (project, worktree, session) = match ctx {
            SessionContext::Worktree {
                project,
                worktree,
                session,
            } => (project, Some(worktree), session),
            SessionContext::Direct { project, session } => (project, None, session),
            SessionContext::Global { .. } => {
                return Err(AttachmentRouteError::NotAgentSession(
                    session_id.to_string(),
                ));
            }
        };

        if session.r#type != SessionType::Agent {
            return Err(AttachmentRouteError::NotAgentSession(
                session_id.to_string(),
            ));
        }

        if parts.is_empty() {
            return Err(AttachmentRouteError::NoFilesProvided);
        }

        let channel = session_channel(session.channel, Some(session.use_tmux));

        let uploads_root = match &worktree {
            Some(wt) => self
                .paths
                .session_data_dir(&project.id, &wt.id, session_id)
                .join("uploads"),
            None => self
                .paths
                .direct_session_data_dir(&project.id, session_id)
                .join("uploads"),
        };

        let mut attachments = Vec::new();

        for part in parts {
            if part.data.len() > MAX_FILE_BYTES {
                return Err(AttachmentRouteError::FileTooLarge(part.filename));
            }

            let safe_name = sanitize_filename(&part.filename)
                .ok_or_else(|| AttachmentRouteError::InvalidFilename(part.filename.clone()))?;

            let upload_id = vst_agents::util::new_uuid_v4();
            let upload_dir = uploads_root.join(&upload_id);

            tokio::fs::create_dir_all(&upload_dir)
                .await
                .map_err(|e| AttachmentRouteError::Internal(e.to_string()))?;

            let file_path = upload_dir.join(&safe_name);
            tokio::fs::write(&file_path, &part.data)
                .await
                .map_err(|e| AttachmentRouteError::Internal(e.to_string()))?;

            let mime = part
                .content_type
                .unwrap_or_else(|| "application/octet-stream".to_string());
            let size = part.data.len() as i64;
            let abs_path_str = file_path.to_string_lossy().to_string();

            let attachment = Attachment {
                id: upload_id.clone(),
                name: safe_name.clone(),
                path: abs_path_str.clone(),
                size,
                mime,
            };

            // Register in in-memory registry
            let attachment_val = serde_json::to_value(&attachment).unwrap_or_default();
            self.attachment_registry
                .register_attachment(session_id, &upload_id, attachment_val);

            // For non-json (terminal/pty) sessions, also stage pending upload reference
            if channel != Channel::Json {
                let ref_path = pending_upload_ref_path(
                    &self.paths,
                    &project,
                    worktree.as_ref(),
                    session_id,
                    &upload_id,
                    &safe_name,
                );
                if let Some(parent) = ref_path.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                let _ = tokio::fs::write(&ref_path, &abs_path_str).await;
            }

            attachments.push(attachment);
        }

        Ok(AttachmentsResult { attachments })
    }

    /// `DELETE /sessions/:id/attachments/:uploadId`
    pub async fn delete_attachment(
        &self,
        session_id: &str,
        upload_id: &str,
    ) -> Result<DeleteAttachmentResult, AttachmentRouteError> {
        let ctx = find_session_context(&self.store, session_id)
            .await
            .ok_or_else(|| AttachmentRouteError::SessionNotFound(session_id.to_string()))?;

        let (project, worktree, _session) = match ctx {
            SessionContext::Worktree {
                project,
                worktree,
                session,
            } => (project, Some(worktree), session),
            SessionContext::Direct { project, session } => (project, None, session),
            SessionContext::Global { .. } => {
                return Err(AttachmentRouteError::SessionNotFound(
                    session_id.to_string(),
                ));
            }
        };

        let removed = self
            .attachment_registry
            .remove_attachment(session_id, upload_id)
            .ok_or_else(|| AttachmentRouteError::UploadNotFound(upload_id.to_string()))?;

        let attachment_name = removed
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        let uploads_root = match &worktree {
            Some(wt) => self
                .paths
                .session_data_dir(&project.id, &wt.id, session_id)
                .join("uploads"),
            None => self
                .paths
                .direct_session_data_dir(&project.id, session_id)
                .join("uploads"),
        };

        let upload_dir = uploads_root.join(upload_id);
        let _ = tokio::fs::remove_dir_all(&upload_dir).await;

        let ref_path = pending_upload_ref_path(
            &self.paths,
            &project,
            worktree.as_ref(),
            session_id,
            upload_id,
            attachment_name,
        );
        let _ = tokio::fs::remove_file(&ref_path).await;

        Ok(DeleteAttachmentResult { ok: true })
    }
}
