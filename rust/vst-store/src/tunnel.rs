//! Persisted view of the cloudflared quick-tunnel's intent + last-known
//! process — ports `daemon/src/state/tunnel-store.ts`. Single-row table
//! (`id = 1`), fail-open: a DB hiccup returns the empty/disabled state.

use rusqlite::{params, Connection};

use crate::{StoreHandle, StoreResult};

const ROW_ID: i64 = 1;

/// The persisted tunnel-state row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TunnelStateRow {
    pub enabled: bool,
    pub current_url: Option<String>,
    pub current_pid: Option<i64>,
    pub started_at: Option<i64>,
    pub port: Option<i64>,
}

impl TunnelStateRow {
    /// The empty/disabled state.
    #[must_use]
    pub fn empty() -> Self {
        TunnelStateRow {
            enabled: false,
            current_url: None,
            current_pid: None,
            started_at: None,
            port: None,
        }
    }
}

fn get_state(conn: &Connection) -> StoreResult<TunnelStateRow> {
    let row = conn
        .query_row(
            "SELECT enabled, currentUrl, currentPid, startedAt, port FROM tunnel_state WHERE id = ?1",
            [ROW_ID],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((enabled, current_url, current_pid, started_at, port)) = row else {
        return Ok(TunnelStateRow::empty());
    };
    Ok(TunnelStateRow {
        enabled: enabled == 1,
        current_url,
        current_pid,
        started_at: started_at.and_then(|s| s.parse::<i64>().ok()),
        port,
    })
}

fn set_state(conn: &Connection, state: &TunnelStateRow) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO tunnel_state (id, enabled, currentUrl, currentPid, startedAt, port)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           enabled=excluded.enabled, currentUrl=excluded.currentUrl,
           currentPid=excluded.currentPid, startedAt=excluded.startedAt, port=excluded.port",
        params![
            ROW_ID,
            if state.enabled { 1 } else { 0 },
            state.current_url,
            state.current_pid,
            state.started_at.map(|s| s.to_string()),
            state.port
        ],
    )?;
    Ok(())
}

fn clear(conn: &Connection) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO tunnel_state (id, enabled, currentUrl, currentPid, startedAt, port)
           VALUES (?1, 0, NULL, NULL, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET
           enabled=0, currentUrl=NULL, currentPid=NULL, startedAt=NULL, port=NULL",
        [ROW_ID],
    )?;
    Ok(())
}

fn clear_process(conn: &Connection) -> StoreResult<()> {
    conn.execute(
        "UPDATE tunnel_state SET currentUrl=NULL, currentPid=NULL, startedAt=NULL WHERE id = ?1",
        [ROW_ID],
    )?;
    Ok(())
}

impl StoreHandle {
    /// Read the single `tunnel_state` row, fail-open to the empty state.
    pub async fn get_tunnel_state(&self) -> TunnelStateRow {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let conn = inner.conn.lock().unwrap();
            get_state(&conn)
        })
        .await
        .unwrap_or_else(|_| Ok(TunnelStateRow::empty()))
        .unwrap_or_else(|_| TunnelStateRow::empty())
    }

    /// Upsert the full row (best-effort on success of `enable()`).
    pub async fn set_tunnel_state(&self, state: TunnelStateRow) {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let conn = inner.conn.lock().unwrap();
            set_state(&conn, &state)
        })
        .await
        .ok();
    }

    /// Full clear — the tunnel was explicitly disabled (next boot won't re-spawn).
    pub async fn clear_tunnel(&self) {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let conn = inner.conn.lock().unwrap();
            clear(&conn)
        })
        .await
        .ok();
    }

    /// Process-only clear — clears pid/url/startedAt but leaves `enabled` alone.
    pub async fn clear_tunnel_process(&self) {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let conn = inner.conn.lock().unwrap();
            clear_process(&conn)
        })
        .await
        .ok();
    }
}

use rusqlite::OptionalExtension;
