//! `routes/orderedLists.ts` — daemon-persisted, cross-client ordered id lists.
//!
//! Ports `daemon/src/routes/orderedLists.ts` (49 LOC):
//! - `GET /user/ordered-lists/:scopeKey`
//! - `PUT /user/ordered-lists/:scopeKey`
//!
//! Scope key is allowlisted to `pinned-all` (PINNED_ALL).
//! Item IDs in PUT is capped at 500 items.

use vst_store::StoreHandle;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::ordered_lists::{
    OrderedList, PutOrderedListBody, PutOrderedListResult, PINNED_ALL,
};

pub const MAX_ORDERED_LIST_ITEMS: usize = 500;

/// Errors surfaced by `ordered-lists` routes.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OrderedListsRouteError {
    #[error("validation_error: invalid scope key '{0}' (expected '{PINNED_ALL}')")]
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
        if scope_key != PINNED_ALL {
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
