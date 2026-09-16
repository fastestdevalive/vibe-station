//! Read/write access to the `global_drafts` table — ports
//! `daemon/src/state/project-store.ts`'s `global_drafts` helpers
//! (`getAllGlobalDrafts`, `addGlobalDraft`, `updateGlobalDraft`,
//! `removeGlobalDraft`).
//!
//! Global drafts are project-less `"drafting"` sessions stored outside any
//! project, surfaced by `GET /sessions` alongside worktree/direct sessions and
//! resolved by `findSessionContext`.

use rusqlite::{params, OptionalExtension};

use crate::{StoreError, StoreHandle, StoreResult};

/// A row from the `global_drafts` table (`GlobalDraftRow` in project-store.ts).
#[derive(Clone, Debug, PartialEq)]
pub struct GlobalDraftRow {
    pub id: String,
    pub draft_prompt: Option<String>,
    /// JSON string.
    pub draft_config: Option<String>,
    pub name: Option<String>,
    pub name_source: Option<String>,
    pub sort_order: Option<f64>,
    pub created_at: String,
}

fn row_to_global_draft(r: &rusqlite::Row) -> rusqlite::Result<GlobalDraftRow> {
    Ok(GlobalDraftRow {
        id: r.get(0)?,
        draft_prompt: r.get(1)?,
        draft_config: r.get(2)?,
        name: r.get(3)?,
        name_source: r.get(4)?,
        sort_order: r.get(5)?,
        created_at: r.get(6)?,
    })
}

impl StoreHandle {
    /// All global drafts, ordered by `createdAt` ascending.
    pub async fn get_all_global_drafts(&self) -> Vec<GlobalDraftRow> {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<Vec<GlobalDraftRow>> {
            let conn = inner.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT id, draftPrompt, draftConfig, name, nameSource, sortOrder, createdAt \
                 FROM global_drafts ORDER BY createdAt ASC",
            )?;
            let rows = stmt
                .query_map([], row_to_global_draft)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .ok()
        .and_then(|res| res.ok())
        .unwrap_or_default()
    }

    /// Look up a single global draft by id.
    pub async fn get_global_draft(&self, id: &str) -> Option<GlobalDraftRow> {
        let inner = self.0.clone();
        let id = id.to_string();
        match tokio::task::spawn_blocking(move || -> StoreResult<Option<GlobalDraftRow>> {
            let conn = inner.conn.lock().unwrap();
            let row = conn
                .query_row(
                    "SELECT id, draftPrompt, draftConfig, name, nameSource, sortOrder, createdAt \
                     FROM global_drafts WHERE id = ?1",
                    params![id],
                    row_to_global_draft,
                )
                .optional()?;
            Ok(row)
        })
        .await
        {
            Ok(Ok(Some(row))) => Some(row),
            _ => None,
        }
    }

    /// Insert a new global draft.
    pub async fn add_global_draft(&self, row: &GlobalDraftRow) -> StoreResult<()> {
        let inner = self.0.clone();
        let row = row.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<()> {
            let conn = inner.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO global_drafts (id, draftPrompt, draftConfig, name, nameSource, sortOrder, createdAt) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    row.id,
                    row.draft_prompt,
                    row.draft_config,
                    row.name,
                    row.name_source,
                    row.sort_order,
                    row.created_at
                ],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Update the mutable fields of an existing global draft. Returns `false`
    /// when no row with `id` exists (no-op).
    pub async fn update_global_draft(
        &self,
        id: &str,
        patch: GlobalDraftPatch,
    ) -> StoreResult<bool> {
        let inner = self.0.clone();
        let id = id.to_string();
        tokio::task::spawn_blocking(move || -> StoreResult<bool> {
            let conn = inner.conn.lock().unwrap();
            let mut sets: Vec<String> = Vec::new();
            let mut vals: Vec<rusqlite::types::Value> = Vec::new();
            // Partial update: only columns with a `Some` patch value are set;
            // untouched columns keep their existing row value.
            let mut push = |col: &'static str, v: Option<rusqlite::types::Value>| {
                if let Some(v) = v {
                    sets.push(format!("{col} = ?"));
                    vals.push(v);
                }
            };
            push(
                "draftPrompt",
                patch.draft_prompt.map(rusqlite::types::Value::Text),
            );
            push(
                "draftConfig",
                patch.draft_config.map(rusqlite::types::Value::Text),
            );
            push("name", patch.name.map(rusqlite::types::Value::Text));
            push(
                "nameSource",
                patch.name_source.map(rusqlite::types::Value::Text),
            );
            push(
                "sortOrder",
                patch.sort_order.map(|n| rusqlite::types::Value::Real(n)),
            );
            if sets.is_empty() {
                return Ok(false);
            }
            let sql = format!("UPDATE global_drafts SET {} WHERE id = ?", sets.join(", "));
            vals.push(rusqlite::types::Value::Text(id));
            let changes = conn.execute(&sql, rusqlite::params_from_iter(vals))?;
            Ok(changes > 0)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Delete a global draft. Returns `false` when no row with `id` existed.
    pub async fn remove_global_draft(&self, id: &str) -> StoreResult<bool> {
        let inner = self.0.clone();
        let id = id.to_string();
        tokio::task::spawn_blocking(move || -> StoreResult<bool> {
            let conn = inner.conn.lock().unwrap();
            let changes = conn.execute("DELETE FROM global_drafts WHERE id = ?1", params![id])?;
            Ok(changes > 0)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }
}

/// Mutable fields of a global draft, updated together.
#[derive(Clone, Debug, Default)]
pub struct GlobalDraftPatch {
    pub draft_prompt: Option<String>,
    pub draft_config: Option<String>,
    pub name: Option<String>,
    pub name_source: Option<String>,
    pub sort_order: Option<f64>,
}
