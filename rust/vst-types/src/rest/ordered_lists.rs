//! `GET/PUT /user/ordered-lists/:scopeKey` — `routes/orderedLists.ts`.

use serde::{Deserialize, Serialize};

/// `GET /user/ordered-lists/:scopeKey` response. `updatedAt` is `null` when no
/// list exists yet. NOT `skip_serializing_none`: the Node daemon (Fastify)
/// emits `"updatedAt": null` explicitly, so F1 byte-compat requires the field
/// to be present as `null` rather than omitted (parity harness, part 10).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderedList {
    pub scope_key: String,
    pub item_ids: Vec<String>,
    pub updated_at: Option<String>,
}

/// `PUT /user/ordered-lists/:scopeKey` request body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutOrderedListBody {
    pub item_ids: Vec<String>,
}

/// `PUT /user/ordered-lists/:scopeKey` success response (ISO-8601 `updatedAt`,
/// never null).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutOrderedListResult {
    pub ok: bool,
    pub scope_key: String,
    pub item_ids: Vec<String>,
    pub updated_at: String,
}

/// The only allowlisted scopeKey.
pub const PINNED_ALL: &str = "pinned-all";
