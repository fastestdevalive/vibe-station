//! Read/write access to the `user_ordered_lists` table (pinned-order-sync) —
//! ports `daemon/src/state/orderedListsStore.ts`. Every query is scoped to the
//! single implicit `'local'` user.

use rusqlite::{params, Connection};

use crate::{StoreHandle, StoreResult};

/// The single implicit user id.
const LOCAL_USER_ID: &str = "local";

/// An ordered id list for a scope key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderedList {
    pub item_ids: Vec<String>,
    pub updated_at: Option<String>,
}

fn get_list(conn: &Connection, scope_key: &str) -> StoreResult<OrderedList> {
    let row = conn
        .query_row(
            "SELECT itemIds, updatedAt FROM user_ordered_lists WHERE userId = ?1 AND scopeKey = ?2",
            params![LOCAL_USER_ID, scope_key],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((item_ids, updated_at)) = row else {
        return Ok(OrderedList {
            item_ids: vec![],
            updated_at: None,
        });
    };
    let parsed = serde_json::from_str::<Vec<String>>(&item_ids).unwrap_or_default();
    Ok(OrderedList {
        item_ids: parsed,
        updated_at: Some(updated_at),
    })
}

impl StoreHandle {
    /// Read the ordered list for a scope key (empty default when absent).
    pub async fn get_ordered_list(&self, scope_key: &str) -> OrderedList {
        let inner = self.0.clone();
        let scope_key = scope_key.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = inner.conn.lock().unwrap();
            get_list(&conn, &scope_key)
        })
        .await
        .unwrap_or_else(|_| {
            Ok(OrderedList {
                item_ids: vec![],
                updated_at: None,
            })
        })
        .unwrap_or_else(|_| OrderedList {
            item_ids: vec![],
            updated_at: None,
        })
    }

    /// Set (overwrite) the ordered list for a scope key, returning the stored
    /// list with its updated-at timestamp.
    pub async fn set_ordered_list(&self, scope_key: &str, item_ids: Vec<String>) -> OrderedList {
        let inner = self.0.clone();
        let scope_key = scope_key.to_string();
        let updated_at = iso_now();
        tokio::task::spawn_blocking(move || -> StoreResult<OrderedList> {
            let conn = inner.conn.lock().unwrap();
            let encoded = serde_json::to_string(&item_ids).unwrap_or_else(|_| "[]".into());
            conn.execute(
                "INSERT INTO user_ordered_lists (userId, scopeKey, itemIds, updatedAt)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(userId, scopeKey) DO UPDATE SET itemIds = excluded.itemIds, updatedAt = excluded.updatedAt",
                params![LOCAL_USER_ID, scope_key, encoded, updated_at],
            )?;
            Ok(OrderedList {
                item_ids,
                updated_at: Some(updated_at),
            })
        })
        .await
        .unwrap_or_else(|_| Ok(OrderedList {
            item_ids: vec![],
            updated_at: None,
        }))
        .unwrap_or_else(|_| OrderedList {
            item_ids: vec![],
            updated_at: None,
        })
    }
}

use rusqlite::OptionalExtension;

/// Best-effort ISO8601 UTC timestamp (second precision).
fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86_400;
    let mut y = 1970_i64;
    let mut remaining = days;
    loop {
        let year_days = if is_leap(y) { 366 } else { 365 };
        if remaining < year_days {
            break;
        }
        remaining -= year_days;
        y += 1;
    }
    let month_days = [
        31,
        if is_leap(y) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut d = remaining;
    let mut month = 1;
    for m in month_days {
        if d < m {
            break;
        }
        d -= m;
        month += 1;
    }
    let sec_of_day = secs % 86_400;
    let (h, mi, s) = (sec_of_day / 3600, (sec_of_day % 3600) / 60, sec_of_day % 60);
    format!("{y:04}-{month:02}-{:02}T{h:02}:{mi:02}:{s:02}Z", d + 1)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
