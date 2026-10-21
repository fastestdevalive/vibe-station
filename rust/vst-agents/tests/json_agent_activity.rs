//! Rich Chat activity reporting: every assistant event is proof of life; no
//! message text is ever captured.

mod common;

use std::sync::{Arc, Mutex};

use vst_agents::json_agent_session::{JsonAgentSession, JsonAgentSessionOptions};
use vst_types::activity::{ActivitySink, ToolActivity};
use vst_types::{Broadcaster, NormalizedEvent, NormalizedEventProvider};

#[derive(Default)]
struct Recorder(Mutex<Vec<(String, String)>>, Mutex<Vec<ToolActivity>>);

impl ActivitySink for Recorder {
    fn record(&self, project_id: &str, session_id: &str) {
        self.0
            .lock()
            .unwrap()
            .push((project_id.into(), session_id.into()));
    }

    fn record_tool(&self, project_id: &str, session_id: &str, tool: ToolActivity) {
        self.1.lock().unwrap().push(tool);
        self.record(project_id, session_id);
    }
}

fn live_session(home: &std::path::Path) -> JsonAgentSession {
    let store_handle =
        vst_store::StoreHandle::open(home.join("vibe-station.db")).expect("open store");
    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    let mut session = common::make_session("sess-act-1");
    session.project_id = "p1".into();
    JsonAgentSession::new(JsonAgentSessionOptions {
        project: common::make_project("p1"),
        worktree: None,
        session,
        plugin: Arc::new(vst_agents::claude::create_claude_plugin()),
        daemon_port: 0,
        cli: NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: Broadcaster(tx),
    })
}

fn event(kind: &str, role: &str, text: Option<&str>) -> NormalizedEvent {
    serde_json::from_value(serde_json::json!({
        "id": format!("e-{kind}-{}", text.unwrap_or("")),
        "sessionId": "sess-act-1",
        "ts": "2026-10-21T00:00:00.000Z",
        "provider": "claude",
        "kind": kind,
        "role": role,
        "text": text,
        "turnId": "t1",
    }))
    .unwrap()
}

#[tokio::test]
async fn assistant_events_report_activity_without_text() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let session = live_session(dir.path());
    let rec = Arc::new(Recorder::default());
    session.attach_activity_sink(rec.clone());

    session
        .handle_event(&mut event("text", "assistant", Some("Hello\nWor")))
        .await;
    session
        .handle_event(&mut event("text", "assistant", Some("ld")))
        .await;
    {
        let calls = rec.0.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], ("p1".to_string(), "sess-act-1".to_string()));
    }

    session
        .handle_event(&mut event("tool_use", "assistant", None))
        .await;
    assert_eq!(rec.0.lock().unwrap().len(), 3);

    session
        .handle_event(&mut event("text", "assistant", Some("Next")))
        .await;
    assert_eq!(rec.0.lock().unwrap().len(), 4);

    // User events never report activity.
    let before = rec.0.lock().unwrap().len();
    session
        .handle_event(&mut event("user", "user", Some("hi")))
        .await;
    assert_eq!(rec.0.lock().unwrap().len(), before);
}

fn tool_event(
    kind: &str,
    id: &str,
    name: Option<&str>,
    input: serde_json::Value,
) -> NormalizedEvent {
    serde_json::from_value(serde_json::json!({
        "id": format!("e-{kind}-{id}"),
        "sessionId": "sess-act-1",
        "ts": "2026-10-21T00:00:00.000Z",
        "provider": "claude",
        "kind": kind,
        "role": "assistant",
        "toolId": id,
        "toolName": name,
        "toolInput": input,
        "turnId": "t1",
    }))
    .unwrap()
}

#[tokio::test]
async fn tool_use_reports_tool_and_late_input_refines_detail() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let session = live_session(dir.path());
    let rec = Arc::new(Recorder::default());
    session.attach_activity_sink(rec.clone());

    // ACP: title-only tool_use with empty input, then the refined input.
    session
        .handle_event(&mut tool_event(
            "tool_use",
            "t1",
            Some("Read"),
            serde_json::json!({}),
        ))
        .await;
    session
        .handle_event(&mut tool_event(
            "tool_result",
            "t1",
            None,
            serde_json::json!({"file_path": "/repo/README.md"}),
        ))
        .await;
    // A different tool id never refines the current tool.
    session
        .handle_event(&mut tool_event(
            "tool_result",
            "other",
            None,
            serde_json::json!({"file_path": "/repo/zzz.md"}),
        ))
        .await;
    let tools = rec.1.lock().unwrap().clone();
    assert_eq!(
        tools,
        vec![
            ToolActivity {
                name: "Read".into(),
                detail: None
            },
            ToolActivity {
                name: "Read".into(),
                detail: Some("README.md".into())
            },
        ]
    );
}
