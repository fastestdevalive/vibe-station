//! The single `ReviewError` -> HTTP mapping.
//!
//! Every route that can surface a review refusal (comments routes, terminal
//! deliveries, chat / schedule / start / reset) answers through
//! [`review_error_parts`], so a status or code can never diverge between them.
//! The match is exhaustive on purpose: a new `ReviewError` variant fails to
//! compile here until it is mapped.

use serde_json::{json, Map, Value};
use vst_types::review::ReviewError;

/// `(status, code, message, extra)` of a review refusal.
pub struct ReviewHttp {
    pub status: u16,
    pub code: &'static str,
    /// Client-safe text. A store failure is logged here and masked.
    pub message: String,
    /// Machine-readable detail (`remaining`, `limit`, `unit`).
    pub extra: Map<String, Value>,
}

impl ReviewHttp {
    /// `{ error: <code>, message, code, ...extra }`.
    pub fn body(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("error".into(), self.code.into());
        obj.insert("message".into(), self.message.clone().into());
        obj.insert("code".into(), self.code.into());
        obj.extend(self.extra.clone());
        Value::Object(obj)
    }
}

/// Map a review error to its HTTP shape (logs and masks `Internal`).
pub fn review_error_parts(e: &ReviewError) -> ReviewHttp {
    let mut extra = Map::new();
    let mut message = e.to_string();
    let (status, code) = match e {
        ReviewError::NotFound => (404, "not_found"),
        ReviewError::InvalidAnchor => (400, "invalid_anchor"),
        ReviewError::InvalidComposer => (400, "invalid_composer"),
        ReviewError::InvalidPath => (422, "invalid_path"),
        ReviewError::CapReached => (409, "cap_reached"),
        ReviewError::TextTooLong => (413, "text_too_long"),
        ReviewError::QuoteTooLong => (413, "quote_too_long"),
        ReviewError::Scope => (409, "scope_mismatch"),
        ReviewError::IdTaken => (409, "id_taken"),
        ReviewError::Changed { remaining } => {
            extra = json!({ "remaining": remaining })
                .as_object()
                .cloned()
                .unwrap_or_default();
            (409, "comments_changed")
        }
        ReviewError::TooLarge { limit, unit } => {
            extra = json!({ "limit": limit, "unit": unit })
                .as_object()
                .cloned()
                .unwrap_or_default();
            (413, "review_too_large")
        }
        ReviewError::NotAttached => (403, "not_attached"),
        ReviewError::InFlight => (409, "delivery_in_flight"),
        ReviewError::Duplicate => (409, "duplicate"),
        ReviewError::Internal(detail) => {
            tracing::warn!("[vst] review store error: {detail}");
            message = "store error".into();
            (500, "internal")
        }
    };
    ReviewHttp {
        status,
        code,
        message,
        extra,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_variant_maps_and_only_internal_is_500() {
        let all = [
            ReviewError::NotFound,
            ReviewError::Changed { remaining: 1 },
            ReviewError::TooLarge {
                limit: 5,
                unit: "bytes",
            },
            ReviewError::NotAttached,
            ReviewError::Scope,
            ReviewError::IdTaken,
            ReviewError::InvalidAnchor,
            ReviewError::InvalidPath,
            ReviewError::InvalidComposer,
            ReviewError::CapReached,
            ReviewError::TextTooLong,
            ReviewError::QuoteTooLong,
            ReviewError::InFlight,
            ReviewError::Duplicate,
            ReviewError::Internal("db exploded at /secret".into()),
        ];
        for e in &all {
            let p = review_error_parts(e);
            if matches!(e, ReviewError::Internal(_)) {
                assert_eq!(p.status, 500);
                assert_eq!(p.message, "store error");
                assert!(!p.body().to_string().contains("secret"));
            } else {
                assert_ne!(p.status, 500, "{e:?}");
                assert_ne!(p.code, "internal", "{e:?}");
            }
        }
        let b = review_error_parts(&ReviewError::Changed { remaining: 3 }).body();
        assert_eq!(b["error"], "comments_changed");
        assert_eq!(b["remaining"], 3);
    }
}
