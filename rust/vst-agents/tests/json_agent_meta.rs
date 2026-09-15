//! Behavior contract for the no-live-session meta assembly free functions of
//! `jsonAgent.ts` (`buildMetaFromTranscript`, `buildMetaFromStoreMeta`,
//! `assembleMeta`, `hasRealUsage`) — the restart-durable meta rebuild path
//! (Decision 8, R2.6) and the `hasRealUsage` usage-clobber gate.

use std::collections::BTreeMap;

use vst_agents::json_agent_session::meta::{
    assemble_meta, build_meta_from_store_meta, build_meta_from_transcript, has_real_usage,
    MetaOptions,
};
use vst_store::transcript::TranscriptMeta;
use vst_types::{
    Channel, NormalizedEvent, NormalizedEventKind, NormalizedEventProvider, SessionMeta, TurnState,
    UsageInfo,
};

fn ev(
    kind: NormalizedEventKind,
    text: Option<&str>,
    model: Option<&str>,
    usage: Option<UsageInfo>,
) -> NormalizedEvent {
    NormalizedEvent {
        id: "id".into(),
        session_id: "sess".into(),
        ts: "2026-01-01T00:00:00.000Z".into(),
        provider: NormalizedEventProvider::Claude,
        kind,
        text: text.map(|s| s.to_string()),
        model: model.map(|s| s.to_string()),
        usage,
        ..Default::default()
    }
}

fn usage(total: i64) -> UsageInfo {
    UsageInfo {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_create_tokens: 0,
        total_tokens: total,
        context_window: None,
        cost_usd: None,
        model: "m".into(),
    }
}

fn base_opts() -> MetaOptions {
    MetaOptions {
        session_id: "sess".into(),
        cli: "claude".into(),
        mode_id: Some("mode-1".into()),
        mode_name: Some("Mode One".into()),
        model_override: None,
        cwd: None,
    }
}

#[test]
fn has_real_usage_gates_zero_token_usage() {
    assert!(!has_real_usage(&None));
    assert!(!has_real_usage(&Some(usage(0))));
    assert!(has_real_usage(&Some(usage(10))));
}

#[test]
fn build_meta_from_transcript_accumulates_last_real_usage_model_commands() {
    let events = vec![
        ev(
            NormalizedEventKind::SessionInit,
            None,
            Some("claude-sonnet-4-5"),
            None,
        ),
        ev(
            NormalizedEventKind::Result,
            None,
            Some("claude-haiku-4-5"),
            Some(usage(100)),
        ),
        // A zero-token usage (slash command) must NOT clobber the real usage.
        ev(
            NormalizedEventKind::Result,
            None,
            Some("claude-haiku-4-5"),
            Some(usage(0)),
        ),
    ];
    let meta = build_meta_from_transcript(&base_opts(), &events);
    assert_eq!(meta.model.as_deref(), Some("claude-haiku-4-5"));
    assert_eq!(meta.usage.as_ref().unwrap().total_tokens, 100);
    assert_eq!(meta.turn_state, TurnState::Idle);
    assert_eq!(meta.queue_depth, 0);
    assert_eq!(meta.channel, Channel::Json);
    assert_eq!(meta.cli, "claude");
}

#[test]
fn model_override_wins_over_transcript_model() {
    let events = vec![ev(
        NormalizedEventKind::Result,
        None,
        Some("claude-haiku-4-5"),
        Some(usage(5)),
    )];
    let opts = MetaOptions {
        model_override: Some("claude-opus-4-5".into()),
        ..base_opts()
    };
    let meta = build_meta_from_transcript(&opts, &events);
    assert_eq!(meta.model.as_deref(), Some("claude-opus-4-5"));
}

#[test]
fn build_meta_from_store_meta_passthrough() {
    let tail = TranscriptMeta {
        model: Some("claude-sonnet-4-6".into()),
        usage: Some(usage(42)),
        commands: None,
    };
    let meta = build_meta_from_store_meta(&base_opts(), &tail);
    assert_eq!(meta.model.as_deref(), Some("claude-sonnet-4-6"));
    assert_eq!(meta.usage.as_ref().unwrap().total_tokens, 42);
    assert_eq!(meta.mode_id.as_deref(), Some("mode-1"));
    assert_eq!(meta.mode_name.as_deref(), Some("Mode One"));
}

#[test]
fn assemble_meta_idle_defaults_and_fields() {
    let meta = assemble_meta(
        &base_opts(),
        &TranscriptMeta {
            model: None,
            usage: None,
            commands: None,
        },
    );
    assert_eq!(meta.turn_state, TurnState::Idle);
    assert_eq!(meta.queue_depth, 0);
    assert!(meta.queued_turn_ids.is_empty());
    assert!(meta.editing_turn_ids.is_empty());
    assert!(meta.model.is_none());
    assert!(meta.usage.is_none());
    // commands omitted when neither source answered and catalog empty.
    assert!(meta.commands.is_none());
    // no cwd, no notice slot.
    assert!(meta.cwd.is_none());
    assert!(meta.notice_slot.is_none());
}

#[test]
fn assemble_meta_includes_cwd() {
    let opts = MetaOptions {
        cwd: Some("/repo".into()),
        ..base_opts()
    };
    let meta = assemble_meta(
        &opts,
        &TranscriptMeta {
            model: None,
            usage: None,
            commands: None,
        },
    );
    assert_eq!(meta.cwd.as_deref(), Some("/repo"));
}

#[test]
fn session_meta_roundtrips_notice_slot_shape() {
    // Ensure the SessionMeta type carries the noticeSlot field for the live path.
    let mut meta = SessionMeta {
        session_id: "sess".into(),
        channel: Channel::Json,
        mode_id: None,
        mode_name: None,
        cli: "claude".into(),
        model: None,
        turn_state: TurnState::Idle,
        queue_depth: 0,
        queued_turn_ids: vec![],
        editing_turn_ids: vec![],
        usage: None,
        cwd: None,
        can_steer: None,
        commands: None,
        notice_slot: None,
    };
    meta.notice_slot = Some(vst_types::NoticeSlot {
        children: BTreeMap::from([("c1".into(), "Child One".into())]),
        running: true,
    });
    let ns = meta.notice_slot.unwrap();
    assert_eq!(ns.children.get("c1").map(|s| s.as_str()), Some("Child One"));
    assert!(ns.running);
}
