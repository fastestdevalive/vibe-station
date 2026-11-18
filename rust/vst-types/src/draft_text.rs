//! Draft text wire types — the server-owned composer draft text
//! (`.vibekit/feature-plans/wip/draft-text-sync`).
//!
//! One row per scope (`global-new`, a session id, `review-picker:<kind>:<id>`),
//! pushed live to every client as `ServerEvent::DraftTextChanged`. The server
//! stores the text opaquely (draft-form mentions/skills included); only the
//! owner module (`vst-daemon/src/draft_text`) validates scopes and enforces the
//! cap. Bodies are never logged.

use serde::{Deserialize, Serialize};

/// Largest accepted draft body, in UTF-8 bytes (R7). Enforced by the daemon
/// owner; a larger `PUT` answers 413 `draft_too_large`.
pub const MAX_DRAFT_TEXT_BYTES: usize = 65_536;

/// One scope's stored draft. An absent row reads as
/// `{ text: "", revision: 0, updatedAt: null, clientId: null }`; `updatedAt`
/// and `clientId` are always serialized (null is meaningful, not "absent").
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftTextDoc {
    pub scope: String,
    pub text: String,
    pub revision: u64,
    pub updated_at: Option<String>,
    pub client_id: Option<String>,
}

/// `PUT /api/draft-texts/:scope` body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutDraftTextBody {
    pub text: String,
    pub client_id: String,
}

/// `GET /api/draft-texts` response: every row, empty tombstones included.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DraftTextListResponse {
    pub drafts: Vec<DraftTextDoc>,
}
