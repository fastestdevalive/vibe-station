//! `POST/DELETE /sessions/:id/attachments...` — `routes/attachments.ts`.

use serde::{Deserialize, Serialize};

use crate::domain::Attachment;

/// `POST /sessions/:id/attachments` success response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentsResult {
    pub attachments: Vec<Attachment>,
}

/// `POST /sessions/:id/attachments` error (file too large, invalid filename).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentsError {
    pub error: String,
}

/// `DELETE /sessions/:id/attachments/:uploadId` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAttachmentResult {
    pub ok: bool,
}
