//! Read/write access to the `draft_texts` table — the server-owned composer
//! draft text (`.vibekit/feature-plans/wip/draft-text-sync`).
//!
//! One row per scope. `put_draft_text` is last-writer-wins with a monotonic
//! `revision`; writing the text already stored is a no-op (`Unchanged`, no
//! event). Empty text is kept as a tombstone: deleting the row would restart
//! `revision` at 1 under open clients that hold a higher one, making them drop
//! real updates. Only session deletion (owner) and the boot orphan sweep remove
//! rows.

use rusqlite::{params, OptionalExtension};

use crate::{StoreError, StoreHandle, StoreResult};

/// A row from the `draft_texts` table.
#[derive(Clone, Debug, PartialEq)]
pub struct DraftTextRow {
    pub scope: String,
    pub text: String,
    pub revision: u64,
    pub updated_at: String,
    pub client_id: Option<String>,
}

/// Result of [`StoreHandle::put_draft_text`]: writing the stored text again
/// leaves the row untouched and produces no broadcast.
#[derive(Clone, Debug, PartialEq)]
pub enum PutOutcome {
    Unchanged(DraftTextRow),
    Written(DraftTextRow),
}

fn row_to_draft_text(r: &rusqlite::Row) -> rusqlite::Result<DraftTextRow> {
    Ok(DraftTextRow {
        scope: r.get(0)?,
        text: r.get(1)?,
        revision: r.get::<_, i64>(2)? as u64,
        updated_at: r.get(3)?,
        client_id: r.get(4)?,
    })
}

const SELECT_COLUMNS: &str = "scope, text, revision, updatedAt, clientId";

impl StoreHandle {
    /// One scope's row, or `None` when no row was ever written.
    pub async fn get_draft_text(&self, scope: &str) -> StoreResult<Option<DraftTextRow>> {
        let inner = self.0.clone();
        let scope = scope.to_string();
        tokio::task::spawn_blocking(move || -> StoreResult<Option<DraftTextRow>> {
            let conn = inner.conn.lock().unwrap();
            let row = conn
                .query_row(
                    &format!("SELECT {SELECT_COLUMNS} FROM draft_texts WHERE scope = ?1"),
                    params![scope],
                    row_to_draft_text,
                )
                .optional()?;
            Ok(row)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Every row, empty tombstones included, ordered by scope.
    pub async fn list_draft_texts(&self) -> StoreResult<Vec<DraftTextRow>> {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<Vec<DraftTextRow>> {
            let conn = inner.conn.lock().unwrap();
            let mut stmt = conn.prepare(&format!(
                "SELECT {SELECT_COLUMNS} FROM draft_texts ORDER BY scope ASC"
            ))?;
            let rows = stmt
                .query_map([], row_to_draft_text)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Last-writer-wins write in one transaction: equal text → `Unchanged`
    /// (row untouched), otherwise `revision = prev + 1` (or 1 for a new scope)
    /// and `updatedAt = now`. Empty text keeps the row as a tombstone.
    pub async fn put_draft_text(
        &self,
        scope: &str,
        text: &str,
        client_id: &str,
        now: &str,
    ) -> StoreResult<PutOutcome> {
        let inner = self.0.clone();
        let scope = scope.to_string();
        let text = text.to_string();
        let client_id = client_id.to_string();
        let now = now.to_string();
        tokio::task::spawn_blocking(move || -> StoreResult<PutOutcome> {
            let mut conn = inner.conn.lock().unwrap();
            let tx = conn.transaction()?;
            let existing: Option<DraftTextRow> = tx
                .query_row(
                    &format!("SELECT {SELECT_COLUMNS} FROM draft_texts WHERE scope = ?1"),
                    params![scope],
                    row_to_draft_text,
                )
                .optional()?;

            let row = match existing {
                Some(row) if row.text == text => {
                    tx.commit()?;
                    return Ok(PutOutcome::Unchanged(row));
                }
                Some(row) => DraftTextRow {
                    scope,
                    text,
                    revision: row.revision + 1,
                    updated_at: now,
                    client_id: Some(client_id),
                },
                None => DraftTextRow {
                    scope,
                    text,
                    revision: 1,
                    updated_at: now,
                    client_id: Some(client_id),
                },
            };

            tx.execute(
                "INSERT INTO draft_texts (scope, text, revision, updatedAt, clientId) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(scope) DO UPDATE SET \
                   text = excluded.text, \
                   revision = excluded.revision, \
                   updatedAt = excluded.updatedAt, \
                   clientId = excluded.clientId",
                params![
                    row.scope,
                    row.text,
                    row.revision as i64,
                    row.updated_at,
                    row.client_id
                ],
            )?;
            tx.commit()?;
            Ok(PutOutcome::Written(row))
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Delete a scope's row. Returns `false` when no row existed.
    pub async fn delete_draft_text(&self, scope: &str) -> StoreResult<bool> {
        let inner = self.0.clone();
        let scope = scope.to_string();
        tokio::task::spawn_blocking(move || -> StoreResult<bool> {
            let conn = inner.conn.lock().unwrap();
            let changes =
                conn.execute("DELETE FROM draft_texts WHERE scope = ?1", params![scope])?;
            Ok(changes > 0)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }
}
