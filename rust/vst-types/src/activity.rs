//! Session activity contract: the sink producers report into.
//!
//! No I/O here (this crate stays dependency-light). The owner that throttles,
//! persists and broadcasts is `vst-activity`; producers (`vst-agents`,
//! `vst-lifecycle`) only see the `ActivitySink` trait, injected from `run.rs`.

/// The tool call a session most recently made, as shown on a dashboard card.
///
/// `name` is a canonical tool name (Claude's: `Edit`, `Bash`, `mcp__srv__tool`,
/// ...), normalised from whatever the CLI reported by the agent layer so no
/// consumer branches on CLI. `detail` is the one short argument worth showing
/// (file basename, first command word, MCP server name) and never a pattern.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivity {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Receives "this session just did something" notifications.
///
/// Fire-and-forget: implementations must be cheap, must not block and must not
/// panic. Throttling, persistence and broadcast are the implementation's job.
pub trait ActivitySink: Send + Sync + 'static {
    fn record(&self, project_id: &str, session_id: &str);

    /// Like [`record`](Self::record), and also reports the tool call the
    /// session just made. Default: ignores the tool (terminal producers).
    fn record_tool(&self, project_id: &str, session_id: &str, _tool: ToolActivity) {
        self.record(project_id, session_id);
    }

    /// The session was deleted or exited: drop any per-session tracking.
    /// Default: no-op.
    fn forget(&self, _session_id: &str) {}
}
