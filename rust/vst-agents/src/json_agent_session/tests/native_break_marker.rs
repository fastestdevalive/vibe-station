//! A native account hand-over keeps the model's context (multi-account
//! Decision 8): the break marker carries `carry_over: native`, so turn 1 must
//! not re-send the system prompt.

use super::*;

/// Decision 8: a native account hand-over copies the conversation and writes
/// a `carry_over: native` marker, leaving 0 rows after the break. The model
/// already has the context, so turn 1 must NOT re-send the system prompt.
#[test]
fn native_break_marker_keeps_first_turn_done() {
    let dir = tempfile::tempdir().unwrap();

    let new_id = "s1";
    // The data dir must be resolved under the test home; the guard is then
    // dropped because `session_in` takes the same (non-reentrant) lock.
    let new_dir = {
        let _home = crate::home::with_home(dir.path().to_path_buf());
        crate::paths::Paths::default().direct_session_data_dir("p1", new_id)
    };
    let old_dir = dir.path().join("old-data");
    {
        let mut old = open_transcript_store(&old_dir, "old1").unwrap();
        let mut turn = NormalizedEvent {
            text: Some("earlier turn".into()),
            ..NormalizedEvent::default()
        };
        old.append(&mut turn);
        old.close();
    }
    let carried = carry_session_transcript(
        &old_dir,
        "old1",
        &new_dir,
        new_id,
        SessionBreakMarker {
            kind: SessionBreakKind::Switch,
            from_provider: Some("claude".into()),
            to_provider: Some("claude".into()),
            provider: NormalizedEventProvider::Claude,
            summary: None,
            carry_over: Some(CarryOver::Native),
            from_mode: None,
            to_mode: None,
            from_account: Some("Work".into()),
            to_account: Some("System login".into()),
            ts: "2026-01-02T00:00:00Z".into(),
        },
        &[],
    );
    assert!(carried > 0, "rows were carried");

    let session = session_in(dir.path());
    assert!(
        !session.is_first_turn_pending(),
        "a native hand-over already has the model's context"
    );
}
