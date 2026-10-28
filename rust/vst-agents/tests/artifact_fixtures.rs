//! Artifact capture against RECORDED ACP traffic (spike C3): the raw
//! `session/update` notifications of real claude / codex adapters are replayed
//! through `normalize_session_update` -> `ToolCallTracker` -> the plugin's
//! `extract_file_effects`, so the extractors are pinned to what the adapters
//! actually send (3.T3, 3.T9, 3.T10).

use agent_client_protocol::schema::v1::SessionUpdate;
use vst_agents::normalize::normalize_session_update;
use vst_agents::plugin::AgentPlugin;
use vst_agents::tool_call_tracker::ToolCallTracker;
use vst_types::artifacts::{FileEffect, FileOp};
use vst_types::NormalizedEventProvider;

fn fixture_updates(name: &str) -> Vec<SessionUpdate> {
    let path = format!(
        "{}/tests/fixtures/acp_writes/{name}.jsonl",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter_map(|v| v.get("notif")?.get("params")?.get("update").cloned())
        .filter_map(|u| serde_json::from_value::<SessionUpdate>(u).ok())
        .collect()
}

/// Effects reported while replaying the first `limit` updates.
fn replay(
    name: &str,
    plugin: &dyn AgentPlugin,
    provider: NormalizedEventProvider,
    limit: usize,
) -> Vec<FileEffect> {
    let mut tracker = ToolCallTracker::new();
    let mut out = Vec::new();
    for u in fixture_updates(name).iter().take(limit) {
        let Some(ev) = normalize_session_update(u, "acp", provider, None) else {
            continue;
        };
        if let Some(call) = tracker.on_event(&ev) {
            out.extend(plugin.extract_file_effects(&call));
        }
    }
    out
}

fn all(name: &str, plugin: &dyn AgentPlugin, provider: NormalizedEventProvider) -> Vec<FileEffect> {
    replay(name, plugin, provider, usize::MAX)
}

/// 3.T9 — every claude Write/Edit yields exactly one `Write` with the absolute
/// path, on `completed`; the Bash `rm`/`mv` yields nothing.
#[test]
fn claude_fixture_yields_one_absolute_write_per_completed_call() {
    let plugin = vst_agents::claude::create_claude_plugin();
    let effects = all("claude", &plugin, NormalizedEventProvider::Claude);
    let base = "/tmp/spike/c3/claude";
    let expect: Vec<FileEffect> = ["a.md", "b.md", "a.md", "b.md", "b.md", "c.md", "d.md"]
        .iter()
        .map(|f| FileEffect::write(format!("{base}/{f}")))
        .collect();
    assert_eq!(effects, expect);
}

/// 3.T9 — the path only arrives mid-call and `completed` carries none, so
/// nothing is captured until `completed`, and a call that never completes
/// records nothing.
#[test]
fn claude_write_is_captured_on_completed_only() {
    let plugin = vst_agents::claude::create_claude_plugin();
    let updates = fixture_updates("claude");
    let completed_at = updates
        .iter()
        .position(|u| match u {
            SessionUpdate::ToolCallUpdate(t) => {
                t.tool_call_id.to_string() == "toolu_01DRfYLztUBsTu9A8kQmgrsE"
                    && t.fields.status
                        == Some(agent_client_protocol::schema::v1::ToolCallStatus::Completed)
            }
            _ => false,
        })
        .expect("first Write completes in the fixture");
    // Up to (excluding) the `completed` update: the location is known, nothing recorded.
    let before = replay(
        "claude",
        &plugin,
        NormalizedEventProvider::Claude,
        completed_at,
    );
    assert!(before.is_empty(), "no effect before completion: {before:?}");
    // Including it: exactly one Write for that call.
    let upto = replay(
        "claude",
        &plugin,
        NormalizedEventProvider::Claude,
        completed_at + 1,
    );
    assert_eq!(
        upto,
        vec![FileEffect::write("/tmp/spike/c3/claude/a.md")],
        "captured on completed"
    );
}

/// 3.T10 / 3.T3 — codex `apply_patch`: one initial `tool_call` with two diff
/// entries -> two `Write`s on `completed`; a patch move is only an add of the
/// NEW path (no `Move`); the recorded shell `execute` calls (heredoc writes and
/// `mv b.md f.md`, relative paths resolved against the input `cwd`) yield
/// writes of their destinations (a `Move` for the `mv`); `rm` and the `python3 -c` write yield nothing.
#[test]
fn codex_fixture_patch_and_shell_yield_writes() {
    let plugin = vst_agents::codex::create_codex_plugin();
    let effects = all("codex", &plugin, NormalizedEventProvider::Codex);
    assert_eq!(
        effects,
        vec![
            FileEffect::write("/tmp/spike/c3/codex/a.md"),
            FileEffect::write("/tmp/spike/c3/codex/b.md"),
            FileEffect::write("/tmp/spike/c3/codex/c.md"),
            FileEffect::write("/tmp/spike/c3/codex/e.md"),
            // shell `mv b.md f.md`: both sides resolved against the input cwd.
            FileEffect::moved("/tmp/spike/c3/codex/b.md", "/tmp/spike/c3/codex/f.md"),
        ]
    );
    assert!(
        effects[..4].iter().all(|e| matches!(e.op, FileOp::Write)),
        "a patch move is only an add of the new path"
    );
}

/// The codex `apply_patch` yields nothing while only its in-progress
/// `tool_call` has been seen: its paths appear on `completed` only.
#[test]
fn codex_patch_waits_for_completed() {
    let plugin = vst_agents::codex::create_codex_plugin();
    let updates = fixture_updates("codex");
    let patch_idx = updates
        .iter()
        .position(|u| matches!(u, SessionUpdate::ToolCall(t) if t.title == "Editing files"))
        .expect("patch call in fixture");
    let before = replay(
        "codex",
        &plugin,
        NormalizedEventProvider::Codex,
        patch_idx + 1,
    );
    // Only the two shell heredoc writes that precede the patch.
    assert_eq!(
        before,
        vec![
            FileEffect::write("/tmp/spike/c3/codex/a.md"),
            FileEffect::write("/tmp/spike/c3/codex/b.md"),
        ]
    );
}

/// 3.T3 — the generic default does NOT see claude shell deletes/moves and does
/// see codex diffs too; opencode/cursor/agy have no override (unmeasured).
#[test]
fn unmeasured_plugins_use_the_generic_default() {
    let cursor = vst_agents::cursor::create_cursor_plugin();
    let codex = vst_agents::codex::create_codex_plugin();
    // Same recorded codex traffic: default (cursor) equals the codex override.
    let via_default = all("codex", &cursor, NormalizedEventProvider::Codex);
    let via_codex = all("codex", &codex, NormalizedEventProvider::Codex);
    assert_eq!(via_default, via_codex);
}

/// L2-02: a codex `edit` call whose shape the recorded fixture does not cover
/// (locations only, no diffs) fails open to the default parser.
#[test]
fn codex_edit_without_diffs_falls_back_to_the_default_parser() {
    use vst_agents::tool_call_tracker::MergedToolCall;
    use vst_types::{AcpToolKind, ToolLocation, ToolStatus};
    let plugin = vst_agents::codex::create_codex_plugin();
    let mut call = MergedToolCall {
        tool_id: "t1".into(),
        name: Some("apply_patch".into()),
        kind: Some(AcpToolKind::Edit),
        status: Some(ToolStatus::Completed),
        input: None,
        locations: vec![ToolLocation {
            path: "/w/a.md".into(),
            line: None,
        }],
        diffs: Vec::new(),
        result_text: None,
    };
    assert_eq!(
        plugin.extract_file_effects(&call),
        vec![FileEffect::write("/w/a.md")]
    );
    // A failed edit still yields nothing (the default's rule).
    call.status = Some(ToolStatus::Failed);
    assert!(plugin.extract_file_effects(&call).is_empty());
}
