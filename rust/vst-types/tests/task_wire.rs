//! Wire shape of the task-tray types (mirrored by `web-ui/src/api/types.ts`).

use serde_json::json;
use vst_types::domain::{TaskKind, TaskOutputKind, TaskState, TaskSummary};
use vst_types::events::ServerEvent;
use vst_types::ws::ServerMessage;
use vst_types::NormalizedEvent;

fn summary() -> TaskSummary {
    TaskSummary {
        id: "b1".into(),
        tool_id: "tool-1".into(),
        kind: TaskKind::Command,
        label: "sleep 90".into(),
        state: TaskState::Stale,
        reason: Some("No end signal from the agent".into()),
        started_at: "2026-10-27T10:00:00.000Z".into(),
        ended_at: None,
        last_activity_at: None,
        output_kind: TaskOutputKind::File,
        output_rev: 3,
        output_path: Some("/tmp/claude-1/x/tasks/b1.output".into()),
        can_stop: false,
    }
}

#[test]
fn task_summary_is_camel_case_and_omits_none() {
    let v = serde_json::to_value(summary()).unwrap();
    assert_eq!(
        v,
        json!({
            "id": "b1", "toolId": "tool-1", "kind": "command", "label": "sleep 90",
            "state": "stale", "reason": "No end signal from the agent",
            "startedAt": "2026-10-27T10:00:00.000Z", "outputKind": "file", "outputRev": 3,
            "outputPath": "/tmp/claude-1/x/tasks/b1.output", "canStop": false
        })
    );
    let back: TaskSummary = serde_json::from_value(v).unwrap();
    assert_eq!(back, summary());
}

#[test]
fn session_tasks_message_tag_and_fields() {
    let m = ServerMessage::SessionTasks {
        session_id: "s".into(),
        rev: 7,
        tasks: vec![],
    };
    assert_eq!(
        serde_json::to_value(m).unwrap(),
        json!({"type": "session:tasks", "sessionId": "s", "rev": 7, "tasks": []})
    );
    let e = ServerEvent::SessionTasksChanged {
        session_id: "s".into(),
        rev: 1,
        tasks: vec![],
    };
    assert_eq!(
        serde_json::to_value(e).unwrap()["type"],
        "session:tasks-changed"
    );
}

#[test]
fn old_normalized_event_rows_deserialise_without_parent_tool_use_id() {
    let mut ev = NormalizedEvent::default();
    ev.id = "e".into();
    let mut v = serde_json::to_value(&ev).unwrap();
    assert!(v.get("parentToolUseId").is_none(), "None is omitted");
    v.as_object_mut().unwrap().remove("parentToolUseId");
    let back: NormalizedEvent = serde_json::from_value(v).unwrap();
    assert_eq!(back.parent_tool_use_id, None);

    ev.parent_tool_use_id = Some("toolu_1".into());
    let v = serde_json::to_value(&ev).unwrap();
    assert_eq!(v["parentToolUseId"], "toolu_1");
}
