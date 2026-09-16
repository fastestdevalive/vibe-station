//! `routes/health.ts` — daemon health check.
//!
//! Ports `daemon/src/routes/health.ts` (14 LOC):
//! - `GET /health`
//!
//! Contract:
//! - Returns `200` with `{ ok: true, version, port, uptime }`
//! - `uptime`: elapsed integer seconds since daemon started.

use std::time::Instant;
use vst_types::rest::health::Health;

/// Handler for `GET /health`.
#[derive(Clone, Debug)]
pub struct HealthRoutes {
    version: String,
    port: i64,
    started_at: Instant,
}

impl HealthRoutes {
    pub fn new(version: impl Into<String>, port: i64, started_at: Instant) -> Self {
        Self {
            version: version.into(),
            port,
            started_at,
        }
    }

    /// `GET /health`
    pub fn health(&self) -> Health {
        let uptime = self.started_at.elapsed().as_secs() as i64;
        Health {
            ok: true,
            version: self.version.clone(),
            port: self.port,
            uptime,
        }
    }
}
