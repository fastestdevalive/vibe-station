//! What a harness plugin reports about one `NormalizedEvent`.

use vst_types::{NormalizedEvent, TaskState};

/// A fact about a background task, derived from persisted event fields only
/// (so a rebuild from the transcript equals live observation).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskObservation {
    /// A tool call asked to run a command in the background.
    CommandLaunched { tool_id: String, command: String },
    /// The tool result confirmed it: background task id (+ output file path).
    /// The registry drops it unless a matching `CommandLaunched` was seen.
    CommandBackgrounded {
        tool_id: String,
        task_id: String,
        output_path: Option<String>,
    },
    /// A subagent (`Task`/`Agent`) tool call started.
    SubagentStarted {
        tool_id: String,
        label: String,
        background: bool,
    },
    /// A tool call nested under a subagent.
    SubagentNested {
        parent_tool_id: String,
        line: String,
    },
    /// A terminal tool result (registry ignores unknown tool ids).
    SubagentFinished {
        tool_id: String,
        ok: bool,
        final_text: Option<String>,
    },
    /// Structured end signal (reserved; unused in v1).
    Ended {
        id: String,
        state: TaskState,
        reason: Option<String>,
    },
}

/// Pure, tolerant detector injected by the owner of the session.
pub type ObservationsFn = dyn Fn(&NormalizedEvent) -> Vec<TaskObservation> + Send + Sync;
