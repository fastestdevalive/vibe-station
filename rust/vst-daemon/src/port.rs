#![forbid(unsafe_code)]

//! Port discovery — ports `findFreePort` from `daemon/src/main.ts`.

use anyhow::{bail, Result};

pub const DEFAULT_PORT: u16 = 7421;
pub const PORT_SEARCH_RANGE: u16 = 100;

/// Returns `true` if `port` can be bound transiently on both the wildcard and
/// loopback addresses (the daemon binds loopback by default, wildcard when
/// network access is on; on some OSes the two probes disagree).
pub fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(format!("0.0.0.0:{port}")).is_ok()
        && std::net::TcpListener::bind(format!("127.0.0.1:{port}")).is_ok()
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
