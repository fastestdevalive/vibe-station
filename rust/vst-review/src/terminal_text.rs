//! Validation of the text of a Terminal (tmux) schedule row, and the helper that
//! reads back the snapshot a scheduled row still holds. Pure functions, no I/O:
//! the route resolves the session and the plugin's caps, then asks here.

use vst_types::artifacts::ScopeKey;
use vst_types::rest::sessions::ScheduledMessageRow;
use vst_types::review::{PayloadState, ReviewRecord, ScheduledReviewPayload};
use vst_types::terminal_delivery::TerminalDeliveryCaps;

use crate::delivery::MAX_PASTE_BYTES;
use crate::sanitize::sanitize_paste_text;

/// Largest Terminal schedule message, measured AFTER control-character
/// stripping (the exact bytes that would be pasted).
pub const MAX_TERMINAL_MESSAGE_BYTES: usize = MAX_PASTE_BYTES;

/// Why Terminal schedule text was refused. The route maps these to its own
/// error type (`Unsupported` -> 4xx "not available", `BadRequest` -> 400).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalTextError {
    /// This agent can't take what was asked (review comments in a single-line CLI).
    Unsupported(String),
    /// The input itself is invalid.
    BadRequest(String),
}

/// Strip, then require: non-empty, within the cap, and single-line unless the
/// CLI takes multi-line pastes. Returns the text to store.
pub fn check_terminal_text(
    raw: &str,
    caps: TerminalDeliveryCaps,
) -> Result<String, TerminalTextError> {
    let text = sanitize_paste_text(raw);
    if text.trim().is_empty() {
        return Err(TerminalTextError::BadRequest(
            "A scheduled message needs text".to_string(),
        ));
    }
    if text.len() > MAX_TERMINAL_MESSAGE_BYTES {
        return Err(TerminalTextError::BadRequest(format!(
            "A scheduled message for a Terminal agent can be at most {} KB",
            MAX_TERMINAL_MESSAGE_BYTES / 1024
        )));
    }
    if !caps.multiline_ok && text.contains('\n') {
        return Err(TerminalTextError::BadRequest(
            "Multi-line messages aren't supported for this agent yet".to_string(),
        ));
    }
    Ok(text)
}

/// The text rules of a Terminal schedule create once the session is known to be
/// alive and its plugin has proven delivery (`caps`): no attachments, review
/// comments need multi-line pastes (and the message may then be empty), and the
/// stripped text is what gets stored (exactly what will be pasted and shown).
pub fn validate_terminal_schedule(
    caps: TerminalDeliveryCaps,
    raw: &str,
    has_attachments: bool,
    with_review: bool,
) -> Result<String, TerminalTextError> {
    if has_attachments {
        return Err(TerminalTextError::BadRequest(
            "Attachments aren't supported on Terminal agents".to_string(),
        ));
    }
    if with_review {
        // The block is always multi-line, and the message may be empty.
        if !caps.multiline_ok {
            return Err(TerminalTextError::Unsupported(
                "This agent can't take review comments in its terminal".to_string(),
            ));
        }
        if sanitize_paste_text(raw).trim().is_empty() {
            return Ok(String::new());
        }
    }
    check_terminal_text(raw, caps)
}

/// A row's `commentsSnapshot` as a payload. Falls back to a tolerant parse (see
/// `ScheduledReviewPayload::parse_checked`) and logs (row id only, never the
/// body) when the snapshot is degraded or unreadable, so "comments lost" is
/// never silent.
pub(crate) fn parse_row_payload(row: &ScheduledMessageRow) -> Option<ScheduledReviewPayload> {
    let raw = row.comments_snapshot.as_deref()?;
    match ScheduledReviewPayload::parse_checked(raw) {
        Ok((p, degraded)) => {
            if degraded {
                tracing::warn!(row_id = %row.id, "commentsSnapshot parsed with fallbacks");
            }
            Some(p)
        }
        Err(e) => {
            // A snapshot-less row carries `{}`-like meta only; anything with
            // comments that fails here is the user's only copy: say so.
            tracing::warn!(row_id = %row.id, "commentsSnapshot unreadable, comments cannot be restored: {e}");
            None
        }
    }
}

/// The snapshot a scheduled row still HOLDS (state `held`), with its scope: what
/// must go back to the panel when the row is cancelled or dismissed.
pub fn held_snapshot(row: &ScheduledMessageRow) -> Option<(ReviewRecord, ScopeKey)> {
    let p = parse_row_payload(row)?;
    (p.state == PayloadState::Held).then(|| {
        (
            ReviewRecord {
                name: p.name,
                comments: p.comments,
            },
            ScopeKey {
                scope_kind: p.scope_kind,
                scope_id: p.scope_id,
            },
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(multiline_ok: bool) -> TerminalDeliveryCaps {
        TerminalDeliveryCaps {
            settle_ms: 200,
            multiline_ok,
            raw_lf: false,
        }
    }

    fn bad_request(r: Result<String, TerminalTextError>) -> String {
        match r {
            Err(TerminalTextError::BadRequest(m)) => m,
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[test]
    fn strips_control_characters_from_the_stored_text() {
        assert_eq!(
            check_terminal_text("a\u{1b}[0m b\u{7}", caps(true)).unwrap(),
            "a[0m b"
        );
    }

    #[test]
    fn rejects_text_that_is_empty_after_stripping() {
        for raw in ["", "   ", "\u{1b}\u{7}  \u{200b}"] {
            assert!(bad_request(check_terminal_text(raw, caps(true))).contains("needs text"));
        }
    }

    #[test]
    fn cap_is_measured_after_stripping_and_exact_at_the_boundary() {
        let exact = "x".repeat(MAX_TERMINAL_MESSAGE_BYTES);
        assert_eq!(
            check_terminal_text(&exact, caps(true)).unwrap().len(),
            MAX_TERMINAL_MESSAGE_BYTES
        );
        let over = "x".repeat(MAX_TERMINAL_MESSAGE_BYTES + 1);
        assert!(bad_request(check_terminal_text(&over, caps(true))).contains("32 KB"));
        // Control characters do not count toward the cap.
        let padded = format!(
            "{}{}",
            "x".repeat(MAX_TERMINAL_MESSAGE_BYTES),
            "\u{1b}".repeat(100)
        );
        assert!(check_terminal_text(&padded, caps(true)).is_ok());
    }

    #[test]
    fn multiline_only_when_the_cli_takes_it() {
        assert_eq!(check_terminal_text("a\nb", caps(true)).unwrap(), "a\nb");
        // CRLF is normalised to LF first, so it is still multi-line.
        assert!(bad_request(check_terminal_text("a\r\nb", caps(false)))
            .contains("Multi-line messages aren't supported"));
        assert_eq!(
            check_terminal_text("one line", caps(false)).unwrap(),
            "one line"
        );
    }

    #[test]
    fn schedule_rules_attachments_and_review_comments() {
        assert!(
            bad_request(validate_terminal_schedule(caps(true), "x", true, false))
                .contains("Attachments")
        );
        assert!(matches!(
            validate_terminal_schedule(caps(false), "x", false, true),
            Err(TerminalTextError::Unsupported(_))
        ));
        // With comments the message may be empty (the block is the message).
        assert_eq!(
            validate_terminal_schedule(caps(true), "  \u{200b}", false, true).unwrap(),
            ""
        );
        assert!(validate_terminal_schedule(caps(true), "  ", false, false).is_err());
    }

    #[test]
    fn held_snapshot_only_for_a_held_payload() {
        let mut row = ScheduledMessageRow {
            id: "r".into(),
            session_id: "s".into(),
            message: String::new(),
            fire_at: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            attachments: None,
            status: "pending".into(),
            sent_at: None,
            sent_turn_id: None,
            failure_reason: None,
            claimed_at: None,
            channel: None,
            delivery_phase: None,
            failure_kind: None,
            comments_snapshot: None,
            origin: None,
        };
        assert!(held_snapshot(&row).is_none());
        let json = |state: &str| {
            format!(
                r#"{{"state":"{state}","scopeKind":"project","scopeId":"p","name":"n","comments":[]}}"#
            )
        };
        row.comments_snapshot = Some(json("held"));
        assert!(held_snapshot(&row).is_some());
        for s in ["adopted", "restored"] {
            row.comments_snapshot = Some(json(s));
            assert!(held_snapshot(&row).is_none(), "{s}");
        }
        // A comment anchored with a state this build does not know still restores
        // (as `cant_check`); the user's only copy is never read as "no comments".
        row.comments_snapshot = Some(
            r#"{"state":"held","scopeKind":"project","scopeId":"p","name":"n","comments":[{"id":"c1","pin":1,"path":"a.rs","pathKind":"repo","surface":"file","quote":"q","text":"t","anchor":"future_state"}]}"#
                .into(),
        );
        let (record, _) = held_snapshot(&row).expect("tolerant parse");
        assert_eq!(record.comments.len(), 1);
    }
}
