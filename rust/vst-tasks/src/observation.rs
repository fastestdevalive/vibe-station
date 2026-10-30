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
    /// The event's turn ended; its BACKGROUND subagents are done (only for
    /// harnesses whose turn is held open until they settle).
    TurnSettled,
    /// Structured state from the harness: the task is running (`paused: false`)
    /// or paused. Authoritative over the liveness probe. Matches a task by its
    /// id, the harness's own id or its tool call id; never creates a task.
    Confirmed {
        id: String,
        tool_id: Option<String>,
        paused: bool,
    },
    /// Structured end signal from the harness: authoritative; arms the grace
    /// window when it drops the hold to zero.
    Ended {
        id: String,
        tool_id: Option<String>,
        state: TaskState,
        reason: Option<String>,
    },
}

/// Pure, tolerant detector injected by the owner of the session.
pub type ObservationsFn = dyn Fn(&NormalizedEvent) -> Vec<TaskObservation> + Send + Sync;
