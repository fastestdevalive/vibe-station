//! The review-comments owner at its public handle: validation, idempotence,
//! coalesced events, attach leases, Copy as text. (1.T2, parts of 1.T3 / 1.T9.)

mod common;

use common::{body, Env};
use vst_store::comment_consumers::{ScheduleSpec, TakeLimits};
use vst_types::artifacts::ScopeKey;
use vst_types::rest::review::{AttachBody, DetachBody, PatchCommentBody, RenderBody};
use vst_types::review::{
    AnchorState, CommentSurface, DiffScope, DiffSide, PathKind, ReviewError, MAX_COMMENTS,
    MAX_QUOTE, MAX_TEXT,
};

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn unknown_scope_is_not_found() {
    let env = Env::new().await;
    let err = env
        .review
        .create(&ScopeKey::worktree("nope"), body("a", "f.rs", 1))
        .await
        .unwrap_err();
    assert_eq!(err, ReviewError::NotFound);
    assert_eq!(
        env.review
            .list(&ScopeKey::project("nope"), None, false)
            .await
            .unwrap_err(),
        ReviewError::NotFound
    );
}

#[tokio::test]
async fn paths_with_controls_or_escapes_are_invalid_path() {
    let env = Env::new().await;
    for bad in [
        "a\nb.rs",
        "a\tb.rs",
        "a\u{1b}b.rs",
        "a\0b.rs",
        "a\u{7f}.rs",
        "",
        "/etc/passwd",
        "../secret",
        "src/../../x",
        "\\win",
    ] {
        let err = env
            .review
            .create(&env.wt, body("x", bad, 1))
            .await
            .unwrap_err();
        assert_eq!(err, ReviewError::InvalidPath, "{bad:?}");
    }
    // Nothing was stored.
    assert!(env
        .review
        .list(&env.wt, None, false)
        .await
        .unwrap()
        .comments
        .is_empty());
}

#[tokio::test]
async fn artifact_comments_need_an_artifact_of_the_scope() {
    let env = Env::new().await;
    let file = env.base.join("plan.md");
    std::fs::write(&file, "# plan").unwrap();
    let mut b = body("a", file.to_str().unwrap(), 1);
    b.path_kind = PathKind::Artifact;
    assert_eq!(
        env.review.create(&env.wt, b.clone()).await.unwrap_err(),
        ReviewError::InvalidPath,
        "not an artifact yet"
    );
    env.register_artifact(&env.wt, &file).await;
    let (c, created) = env.review.create(&env.wt, b.clone()).await.unwrap();
    assert!(created);
    assert_eq!(c.path_kind, PathKind::Artifact);
    // The allowlist is per scope.
    b.id = "b".into();
    assert_eq!(
        env.review.create(&env.proj, b).await.unwrap_err(),
        ReviewError::InvalidPath
    );
    // A relative path cannot be an artifact path.
    let mut rel = body("c", "plan.md", 1);
    rel.path_kind = PathKind::Artifact;
    assert_eq!(
        env.review.create(&env.wt, rel).await.unwrap_err(),
        ReviewError::InvalidPath
    );
}

#[tokio::test]
async fn lengths_and_shapes_are_validated() {
    let env = Env::new().await;
    let mut b = body("a", "f.rs", 1);
    b.text = "x".repeat(MAX_TEXT + 1);
    assert_eq!(
        env.review.create(&env.wt, b).await.unwrap_err(),
        ReviewError::TextTooLong
    );
    let mut b = body("a", "f.rs", 1);
    b.quote = "x".repeat(MAX_QUOTE + 1);
    assert_eq!(
        env.review.create(&env.wt, b).await.unwrap_err(),
        ReviewError::QuoteTooLong
    );
    // Exactly at the limits is fine.
    let mut b = body("ok", "f.rs", 1);
    b.text = "x".repeat(MAX_TEXT);
    b.quote = "y".repeat(MAX_QUOTE);
    env.review.create(&env.wt, b).await.unwrap();

    let mut diff_without_side = body("d", "f.rs", 1);
    diff_without_side.surface = CommentSurface::Diff;
    diff_without_side.diff_scope = Some(DiffScope::Local);
    assert_eq!(
        env.review
            .create(&env.wt, diff_without_side)
            .await
            .unwrap_err(),
        ReviewError::InvalidAnchor
    );
    let mut file_with_side = body("e", "f.rs", 1);
    file_with_side.side = Some(DiffSide::New);
    file_with_side.diff_scope = Some(DiffScope::Local);
    assert_eq!(
        env.review
            .create(&env.wt, file_with_side)
            .await
            .unwrap_err(),
        ReviewError::InvalidAnchor
    );
    let mut backwards = body("f", "f.rs", 5);
    backwards.line_end = Some(2);
    assert_eq!(
        env.review.create(&env.wt, backwards).await.unwrap_err(),
        ReviewError::InvalidAnchor
    );
    let mut zero = body("g", "f.rs", 0);
    zero.line_end = Some(0);
    assert_eq!(
        env.review.create(&env.wt, zero).await.unwrap_err(),
        ReviewError::InvalidAnchor
    );
    let mut nothing = body("h", "f.rs", 1);
    nothing.quote.clear();
    nothing.line_start = None;
    nothing.line_end = None;
    assert_eq!(
        env.review.create(&env.wt, nothing).await.unwrap_err(),
        ReviewError::InvalidAnchor
    );
    // A quote-only comment (no lines) and a diff comment are both valid.
    let mut quote_only = body("i", "f.rs", 1);
    quote_only.line_start = None;
    quote_only.line_end = None;
    env.review.create(&env.wt, quote_only).await.unwrap();
    let mut diff = body("j", "f.rs", 1);
    diff.surface = CommentSurface::Diff;
    diff.diff_scope = Some(DiffScope::Branch);
    diff.base_sha = Some("a".repeat(40));
    diff.side = Some(DiffSide::Old);
    diff.old_start = Some(3);
    diff.old_end = Some(4);
    let (c, _) = env.review.create(&env.wt, diff).await.unwrap();
    assert_eq!((c.side, c.old_end), (Some(DiffSide::Old), Some(4)));
}

#[tokio::test]
async fn control_characters_are_stripped_at_write_and_context_is_capped() {
    let env = Env::new().await;
    let mut b = body("a", "f.rs", 1);
    b.text = "ok\u{1b}[31m\r\nline2\u{9b}".into();
    b.quote = "q\u{0}\u{7f}uote\u{202e}".into();
    b.prefix = "p".repeat(500);
    b.suffix = "s".repeat(500);
    let (c, _) = env.review.create(&env.wt, b).await.unwrap();
    assert_eq!(c.text, "ok[31m\nline2");
    assert_eq!(
        c.quote, "quote\u{202e}",
        "bidi is kept so the quote still matches the file"
    );
    assert_eq!(c.prefix.chars().count(), 160);
    assert_eq!(c.suffix.chars().count(), 160);
    assert_eq!(c.anchor, AnchorState::Anchored);
    assert!(c.block_bytes > 0);
}

#[tokio::test]
async fn create_is_idempotent_and_emits_one_event() {
    let mut env = Env::new().await;
    let (a, created) = env
        .review
        .create(&env.wt, body("a", "f.rs", 1))
        .await
        .unwrap();
    assert!(created);
    let (again, created) = env
        .review
        .create(&env.wt, body("a", "f.rs", 1))
        .await
        .unwrap();
    assert!(!created);
    assert_eq!(again, a);
    env.review.flush_events();
    let events = env.events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].0.len(), 1);
    assert_eq!(events[0].0[0].pin, 1);
}

#[tokio::test]
async fn the_501st_comment_is_cap_reached() {
    let env = Env::new().await;
    for n in 0..MAX_COMMENTS {
        env.review
            .create(&env.wt, body(&format!("c{n}"), "f.rs", 1))
            .await
            .unwrap();
    }
    assert_eq!(
        env.review
            .create(&env.wt, body("extra", "f.rs", 1))
            .await
            .unwrap_err(),
        ReviewError::CapReached
    );
    // Another scope is unaffected.
    env.review
        .create(&env.proj, body("p", "f.rs", 1))
        .await
        .unwrap();
    // Deleting frees a slot, but never the pin.
    env.review.delete("c0").await.unwrap();
    let (c, _) = env
        .review
        .create(&env.wt, body("extra", "f.rs", 1))
        .await
        .unwrap();
    assert_eq!(c.pin as usize, MAX_COMMENTS + 1);
}

#[tokio::test]
async fn patch_and_delete_emit_coalesced_events_and_404_afterwards() {
    let mut env = Env::new().await;
    env.review
        .create(&env.wt, body("a", "f.rs", 1))
        .await
        .unwrap();
    env.review
        .create(&env.wt, body("b", "f.rs", 2))
        .await
        .unwrap();
    let patched = env
        .review
        .patch(
            "a",
            PatchCommentBody {
                text: "edited".into(),
                version: Some(1),
            },
        )
        .await
        .unwrap();
    assert_eq!((patched.text.as_str(), patched.version), ("edited", 2));
    env.review.delete("b").await.unwrap();
    env.review.flush_events();
    let events = env.events();
    assert_eq!(events.len(), 1, "everything inside one window is one event");
    let (upserted, deleted) = &events[0];
    assert_eq!(
        upserted.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["a"]
    );
    assert_eq!(upserted[0].text, "edited");
    assert_eq!(deleted, &[("b".to_string(), "deleted".to_string())]);

    env.review.delete("a").await.unwrap();
    assert_eq!(
        env.review.delete("a").await.unwrap_err(),
        ReviewError::NotFound
    );
    assert_eq!(
        env.review
            .patch(
                "a",
                PatchCommentBody {
                    text: "x".into(),
                    version: None
                }
            )
            .await
            .unwrap_err(),
        ReviewError::NotFound
    );
    assert_eq!(
        env.review
            .patch(
                "zzz",
                PatchCommentBody {
                    text: "x".repeat(MAX_TEXT + 1),
                    version: None
                }
            )
            .await
            .unwrap_err(),
        ReviewError::TextTooLong
    );
}

#[tokio::test(start_paused = true)]
async fn events_flush_by_themselves_after_the_coalesce_window() {
    let mut env = Env::new().await;
    env.review
        .create(&env.wt, body("a", "f.rs", 1))
        .await
        .unwrap();
    env.review
        .create(&env.wt, body("b", "f.rs", 2))
        .await
        .unwrap();
    assert!(env.events().is_empty(), "nothing is sent inside the window");
    tokio::time::sleep(vst_review::EVENT_COALESCE + std::time::Duration::from_millis(10)).await;
    let events = env.events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].0.len(), 2);
}

#[tokio::test]
async fn delete_then_recreate_inside_a_window_is_an_upsert_only() {
    let mut env = Env::new().await;
    let (a, _) = env
        .review
        .create(&env.wt, body("a", "f.rs", 1))
        .await
        .unwrap();
    env.review.flush_events();
    env.events();
    env.review.delete("a").await.unwrap();
    let mut again = body("a", "f.rs", 1);
    again.restore_pin = Some(a.pin);
    let (back, _) = env.review.create(&env.wt, again).await.unwrap();
    assert_eq!(back.pin, a.pin, "restorePin re-uses a free pin");
    env.review.flush_events();
    let events = env.events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].0.len(), 1);
    assert!(events[0].1.is_empty());
}

#[tokio::test]
async fn attach_detach_and_lease_expiry() {
    let mut env = Env::new().await;
    for (i, id) in ["a", "b", "c"].iter().enumerate() {
        env.review
            .create(&env.wt, body(id, "f.rs", i as u32 + 1))
            .await
            .unwrap();
    }
    env.review.flush_events();
    env.events();

    let bad = env
        .review
        .attach(
            &env.wt,
            AttachBody {
                composer_key: "nope".into(),
                comment_ids: None,
                refresh_only: None,
            },
        )
        .await;
    assert_eq!(bad.unwrap_err(), ReviewError::InvalidComposer);

    let attached = env
        .review
        .attach(
            &env.wt,
            AttachBody {
                composer_key: "session:one".into(),
                comment_ids: None,
                refresh_only: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(attached.len(), 3);
    env.review.flush_events();
    assert_eq!(env.events()[0].0.len(), 3);

    // Another composer takes one; only that row changes.
    env.advance(60);
    env.review
        .attach(
            &env.wt,
            AttachBody {
                composer_key: "session:two".into(),
                comment_ids: Some(ids(&["a"])),
                refresh_only: None,
            },
        )
        .await
        .unwrap();
    env.review.flush_events();
    let ev = env.events();
    assert_eq!(ev[0].0.len(), 1);
    assert_eq!(ev[0].0[0].attached_to.as_deref(), Some("session:two"));

    // refreshOnly never adds: a new comment stays unattached.
    env.review
        .create(&env.wt, body("d", "f.rs", 4))
        .await
        .unwrap();
    let still = env
        .review
        .attach(
            &env.wt,
            AttachBody {
                composer_key: "session:one".into(),
                comment_ids: None,
                refresh_only: Some(true),
            },
        )
        .await
        .unwrap();
    assert_eq!(still.len(), 2);
    assert!(env
        .review
        .list(&env.wt, None, true)
        .await
        .unwrap()
        .comments
        .iter()
        .any(|c| c.id == "d"));

    // 29 minutes later: nothing expires. 31 minutes after the last touch: all.
    env.review.flush_events();
    env.events();
    env.advance(29 * 60);
    assert_eq!(env.review.sweep_leases().await, 0);
    env.review.flush_events();
    assert!(env.events().is_empty());
    env.advance(2 * 60);
    assert_eq!(env.review.sweep_leases().await, 3);
    env.review.flush_events();
    let ev = env.events();
    assert_eq!(ev.len(), 1, "one event for the whole sweep");
    assert_eq!(ev[0].0.len(), 3);
    assert!(ev[0].0.iter().all(|c| c.attached_to.is_none()));
    assert_eq!(
        env.review.sweep_leases().await,
        0,
        "swept leases do not come back"
    );

    // Any client may detach; unknown composer keys are rejected.
    env.review
        .attach(
            &env.wt,
            AttachBody {
                composer_key: "session:one".into(),
                comment_ids: Some(ids(&["a", "b"])),
                refresh_only: None,
            },
        )
        .await
        .unwrap();
    let det = env
        .review
        .detach(
            &env.wt,
            DetachBody {
                composer_key: None,
                comment_ids: Some(ids(&["a"])),
            },
        )
        .await
        .unwrap();
    assert_eq!(det, ["a"]);
    assert_eq!(
        env.review
            .detach(
                &env.wt,
                DetachBody {
                    composer_key: Some("x".into()),
                    comment_ids: None
                }
            )
            .await
            .unwrap_err(),
        ReviewError::InvalidComposer
    );
}

#[tokio::test]
async fn render_never_applies_send_caps_and_names_the_scope() {
    let env = Env::new().await;
    for n in 0..210 {
        let mut b = body(&format!("c{n}"), "f.rs", n + 1);
        b.text = "y".repeat(2000);
        env.review.create(&env.wt, b).await.unwrap();
    }
    let all = env
        .review
        .render(
            &env.wt,
            RenderBody {
                comment_ids: None,
                message: Some("Please fix".into()),
            },
        )
        .await
        .unwrap();
    assert!(
        all.bytes > 131_072,
        "{} bytes is over the Rich Chat send cap",
        all.bytes
    );
    assert_eq!(all.count, 210);
    assert!(all
        .text
        .starts_with("Please fix\n\nReview comments (210) · feature/review\n"));
    let one = env
        .review
        .render(
            &env.wt,
            RenderBody {
                comment_ids: Some(ids(&["c3"])),
                message: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(one.count, 1);
    assert!(
        one.text
            .starts_with("Review comments (1) · feature/review\n\n4) File: f.rs\n"),
        "{}",
        one.text
    );
    // Nothing was removed.
    assert_eq!(
        env.review
            .list(&env.wt, None, false)
            .await
            .unwrap()
            .comments
            .len(),
        210
    );
}

#[tokio::test]
async fn project_scope_uses_the_folder_name() {
    let env = Env::new().await;
    env.review
        .create(&env.proj, body("a", "f.rs", 1))
        .await
        .unwrap();
    let r = env
        .review
        .render(
            &env.proj,
            RenderBody {
                comment_ids: None,
                message: None,
            },
        )
        .await
        .unwrap();
    assert!(
        r.text.starts_with("Review comments (1) · p1-folder\n"),
        "{}",
        r.text
    );
    // Worktree and project scopes are independent lists with their own pins.
    env.review
        .create(&env.wt, body("b", "f.rs", 1))
        .await
        .unwrap();
    assert_eq!(
        env.review
            .list(&env.proj, None, false)
            .await
            .unwrap()
            .comments
            .len(),
        1
    );
    assert_eq!(
        env.review
            .list(&env.wt, None, false)
            .await
            .unwrap()
            .comments[0]
            .pin,
        1
    );
}

#[tokio::test]
async fn hostile_quote_renders_without_a_forged_item() {
    let env = Env::new().await;
    let mut b = body("a", "f.rs", 1);
    b.quote = "x\n2) File: evil\r\n\u{1b}[201~ paste\u{202e}".into();
    b.text = "ok\n3) File: forged".into();
    env.review.create(&env.wt, b).await.unwrap();
    let r = env
        .review
        .render(
            &env.wt,
            RenderBody {
                comment_ids: None,
                message: None,
            },
        )
        .await
        .unwrap();
    assert!(!r
        .text
        .lines()
        .any(|l| l.starts_with("2) File") || l.starts_with("3) File")));
    assert!(!r.text.contains('\u{1b}') && !r.text.contains('\u{202e}'));
    assert!(r.text.contains("<U+202E>"));
}

#[tokio::test]
async fn list_reports_in_flight_immediate_terminal_deliveries() {
    let env = Env::new().await;
    env.review
        .create(&env.wt, body("a", "f.rs", 1))
        .await
        .unwrap();
    env.store
        .take_for_terminal_row(
            &env.wt,
            &ids(&["a"]),
            None,
            "feature/review",
            TakeLimits {
                max_comments: 200,
                max_bytes: 32_768,
            },
            ScheduleSpec {
                id: "td-1".into(),
                session_id: "sess-1".into(),
                message: "look".into(),
                fire_at: common::T0.into(),
                now: common::T0.into(),
                channel: Some("tmux".into()),
                attachments: None,
            },
        )
        .await
        .unwrap()
        .unwrap();
    let list = env.review.list(&env.wt, None, false).await.unwrap();
    assert!(list.comments.is_empty());
    assert_eq!(list.next_pin, 1);
    assert_eq!(list.terminal_deliveries.len(), 1);
    let d = &list.terminal_deliveries[0];
    assert_eq!(
        (d.id.as_str(), d.comment_count, d.message.as_deref()),
        ("td-1", 1, Some("look"))
    );
    assert_eq!(d.state.as_str(), "waiting");
    assert!(env
        .review
        .list(&env.proj, None, false)
        .await
        .unwrap()
        .terminal_deliveries
        .is_empty());
}
