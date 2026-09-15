//! `GET /health` — `routes/health.ts`.

use serde::{Deserialize, Serialize};

/// `GET /health` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub version: String,
    pub port: i64,
    /// integer seconds
    pub uptime: i64,
}
