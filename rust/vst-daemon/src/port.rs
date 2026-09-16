#![forbid(unsafe_code)]

//! Port discovery — ports `findFreePort` from `daemon/src/main.ts`.

use anyhow::{bail, Result};

pub const DEFAULT_PORT: u16 = 7421;
pub const PORT_SEARCH_RANGE: u16 = 100;

/// Returns `true` if `0.0.0.0:port` can be bound transiently.
pub fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(format!("0.0.0.0:{port}")).is_ok()
}

/// Find the first free port in `[start, start + PORT_SEARCH_RANGE)`.
pub fn find_free_port(start: u16) -> Result<u16> {
    for p in start..start.saturating_add(PORT_SEARCH_RANGE) {
        if port_is_free(p) {
            return Ok(p);
        }
    }
    bail!(
        "No free port found in range {start}–{}",
        start + PORT_SEARCH_RANGE - 1
    )
}
