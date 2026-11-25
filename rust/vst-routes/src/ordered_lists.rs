//! `routes/orderedLists.ts` — daemon-persisted, cross-client ordered id lists.
//!
//! Ports `daemon/src/routes/orderedLists.ts` (49 LOC):
//! - `GET /user/ordered-lists/:scopeKey`
//! - `PUT /user/ordered-lists/:scopeKey`
//!
//! Scope key is allowlisted to `pinned-all` and `projects` (ORDERED_LIST_SCOPES).
//! Item IDs in PUT is capped at 500 items.

use std::collections::HashSet;

use vst_store::StoreHandle;
use vst_types::domain::{ProjectRecord, SessionType};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::ordered_lists::{
    OrderedList, PutOrderedListBody, PutOrderedListResult, ORDERED_LIST_SCOPES, PINNED_ALL,
};

pub const MAX_ORDERED_LIST_ITEMS: usize = 500;

/// Errors surfaced by `ordered-lists` routes.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OrderedListsRouteError {
    #[error(
        "validation_error: invalid scope key '{0}' (expected one of 'pinned-all', 'projects')"
    )]
    InvalidScopeKey(String),
    #[error("validation_error: itemIds length exceeds maximum of {MAX_ORDERED_LIST_ITEMS}")]
    ItemIdsTooLong,
}

impl OrderedListsRouteError {
    pub fn error_code(&self) -> &'static str {
        "validation_error"
    }
}

/// Handler for `/user/ordered-lists/:scopeKey`.
#[derive(Clone)]
pub struct OrderedListsRoutes {
    pub store: StoreHandle,
    pub broadcaster: Broadcaster,
}

impl OrderedListsRoutes {
    pub fn new(store: StoreHandle, broadcaster: Broadcaster) -> Self {
        Self { store, broadcaster }
    }

    fn validate_scope_key(scope_key: &str) -> Result<(), OrderedListsRouteError> {
        if !ORDERED_LIST_SCOPES.contains(&scope_key) {
            return Err(OrderedListsRouteError::InvalidScopeKey(
                scope_key.to_string(),
            ));
        }
        Ok(())
    }

    /// `GET /user/ordered-lists/:scopeKey`
    pub async fn get_ordered_list(
        &self,
        scope_key: &str,
    ) -> Result<OrderedList, OrderedListsRouteError> {
        Self::validate_scope_key(scope_key)?;
        let record = self.store.get_ordered_list(scope_key).await;
        Ok(OrderedList {
            scope_key: scope_key.to_string(),
            item_ids: record.item_ids,
            updated_at: record.updated_at,
        })
    }

    /// `PUT /user/ordered-lists/:scopeKey`
    pub async fn put_ordered_list(
        &self,
        scope_key: &str,
        body: PutOrderedListBody,
    ) -> Result<PutOrderedListResult, OrderedListsRouteError> {
        Self::validate_scope_key(scope_key)?;
        if body.item_ids.len() > MAX_ORDERED_LIST_ITEMS {
            return Err(OrderedListsRouteError::ItemIdsTooLong);
        }

        let record = self
            .store
            .set_ordered_list(scope_key, body.item_ids.clone())
            .await;
        let updated_at = record.updated_at.unwrap_or_default();

        self.broadcaster.send(ServerEvent::OrderedListUpdated {
            scope_key: scope_key.to_string(),
            item_ids: record.item_ids.clone(),
            updated_at: updated_at.clone(),
        });

        Ok(PutOrderedListResult {
            ok: true,
            scope_key: scope_key.to_string(),
            item_ids: record.item_ids,
            updated_at,
        })
    }
}

/// What `pin_to_top` knows about the store when it builds the new list.
#[derive(Debug, Clone, Default)]
pub struct PinnedSnapshot {
    /// The sidebar's pinned set, newest `pinnedAt` first.
    pub pinned: Vec<String>,
    /// Every worktree and session id that still exists, read BEFORE the list
    /// lock is taken. An id created (or swapped in by a reset) after this
    /// snapshot would look dead, so `pin_to_top_list` consults it only under
    /// cap pressure.
    pub live: HashSet<String>,
}

/// Pure: `[id] ++ (pinned ids missing from `stored`, excluding `id`) ++
/// (`stored` minus `id`)`, capped at [`MAX_ORDERED_LIST_ITEMS`]. Stored ids
/// are kept as-is unless the result would exceed the cap; then ids of deleted
/// items (not in `snap.live`) are dropped first and the tail truncated after.
/// Pruning only under pressure keeps a snapshot taken before the list lock
/// from dropping a live id that was created after it. `None` when the result
/// equals `stored`.
pub fn pin_to_top_list(stored: &[String], snap: &PinnedSnapshot, id: &str) -> Option<Vec<String>> {
    let stored_set: HashSet<&str> = stored.iter().map(String::as_str).collect();
    let mut head = vec![id.to_string()];
    head.extend(
        snap.pinned
            .iter()
            .filter(|p| *p != id && !stored_set.contains(p.as_str()))
            .cloned(),
    );
    let mut rest: Vec<String> = stored.iter().filter(|s| *s != id).cloned().collect();
    if head.len() + rest.len() > MAX_ORDERED_LIST_ITEMS {
        rest.retain(|s| snap.live.contains(s.as_str()));
    }
    let mut out = head;
    out.extend(rest);
    out.truncate(MAX_ORDERED_LIST_ITEMS);
    (out != stored).then_some(out)
}

/// Pure: `stored` without `id`, or `None` when `id` is absent.
pub fn remove_id(ids: &[String], id: &str) -> Option<Vec<String>> {
    ids.iter()
        .any(|i| i == id)
        .then(|| ids.iter().filter(|i| *i != id).cloned().collect())
}

/// Build the [`PinnedSnapshot`]. Pinned = pinned worktrees (hidden ones
/// included) plus pinned DIRECT agent sessions that are not superseded (a
/// `superseded_by` resolving to a row in the same project; a dangling one does
/// not count), ordered like the sidebar: `pinnedAt` string DESC.
pub fn pinned_snapshot(projects: &[ProjectRecord]) -> PinnedSnapshot {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut live: HashSet<String> = HashSet::new();
    for p in projects {
        for w in &p.worktrees {
            live.insert(w.id.clone());
            if let Some(at) = &w.pinned_at {
                out.push((at.clone(), w.id.clone()));
            }
        }
        let all_ids: HashSet<&str> = p
            .worktrees
            .iter()
            .flat_map(|w| w.sessions.iter())
            .chain(p.direct_sessions.iter())
            .map(|s| s.id.as_str())
            .collect();
        live.extend(all_ids.iter().map(|s| (*s).to_string()));
        for s in &p.direct_sessions {
            let Some(at) = &s.pinned_at else { continue };
            if s.worktree_id.is_some() || s.r#type != SessionType::Agent {
                continue;
            }
            if s.superseded_by
                .as_deref()
                .is_some_and(|n| all_ids.contains(n))
            {
                continue;
            }
            out.push((at.clone(), s.id.clone()));
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    PinnedSnapshot {
        pinned: out.into_iter().map(|(_, id)| id).collect(),
        live,
    }
}

/// Broadcast the outcome of a `pinned-all` mutation: an event when it wrote,
/// nothing when unchanged, a warning (id only) when the store failed. The
/// list is a display order, so a failure never fails the caller's request.
pub fn announce_pinned_all(
    b: &Broadcaster,
    outcome: vst_store::StoreResult<Option<vst_store::OrderedList>>,
    context: &str,
) {
    match outcome {
        Ok(Some(list)) => b.send(ServerEvent::OrderedListUpdated {
            scope_key: PINNED_ALL.to_string(),
            item_ids: list.item_ids,
            updated_at: list.updated_at.unwrap_or_default(),
        }),
        Ok(None) => {}
        Err(e) => tracing::warn!(context, error = %e, "pinned-all update failed"),
    }
}

/// Put `id` at the top of `pinned-all` (complete list, one atomic mutation)
/// and broadcast when it changed. Best effort: never fails the pin.
pub async fn pin_to_top(store: &StoreHandle, b: &Broadcaster, id: &str) {
    // Project lock first and released; the list closure never touches projects.
    let snap = pinned_snapshot(&store.get_all_projects().await);
    let id_owned = id.to_string();
    let outcome = store
        .update_ordered_list(PINNED_ALL, move |stored| {
            pin_to_top_list(stored, &snap, &id_owned)
        })
        .await;
    announce_pinned_all(b, outcome, id);
}

/// Remove `id` from `pinned-all`, broadcasting only when it was present.
pub async fn unpin_remove(store: &StoreHandle, b: &Broadcaster, id: &str) {
    let id_owned = id.to_string();
    let outcome = store
        .update_ordered_list(PINNED_ALL, move |stored| remove_id(stored, &id_owned))
        .await;
    announce_pinned_all(b, outcome, id);
}

/// Replace `old_id` with `new_id` in a `pinned-all` id list. `None` when
/// `old_id` is absent (nothing to do); if `new_id` is already present, only
/// `old_id` is removed.
pub fn swap_pinned_all_id(ids: &[String], old_id: &str, new_id: &str) -> Option<Vec<String>> {
    let pos = ids.iter().position(|i| i == old_id)?;
    let mut out = ids.to_vec();
    if ids.iter().any(|i| i == new_id) {
        out.remove(pos);
    } else {
        out[pos] = new_id.to_string();
    }
    Some(out)
}
