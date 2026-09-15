//! ACP `terminal/*` handler — the "host-managed terminal" half of the daemon's
//! ACP Client surface. Ports `daemon/src/services/acp/acpTerminalManager.ts`.
//!
//! When the wrapped CLI backgrounds a shell command (a dev server, `sleep 60
//! &`, …), the adapter routes it through here instead of spawning a bare OS
//! child the CLI process owns. The daemon then holds the real child handle, so
//! the work survives past any single turn.
//!
//! Spawns via `vst-proc`'s `spawn_child`/`PtyHandle` (the shared subprocess
//! abstraction the arch predicted — `vst-agents`' ACP child processes and tmux
//! PTYs share one spawn contract), NOT a hand-rolled `tokio::process::Command`.
//!
//! Zero CLI-specific logic (AGENTS.md) — identical for every plugin.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use vst_proc::{spawn_child, PtyHandle, SpawnChildOptions};

/// Parameters for `terminal/create` (agent → client request).
#[derive(Debug, Clone)]
pub struct TerminalCreateParams {
    /// Program to exec.
    pub command: String,
    /// argv for the program (excluding argv[0]).
    pub args: Vec<String>,
    /// Working directory; `None` → inherit the daemon's cwd.
    pub cwd: Option<PathBuf>,
    /// Extra env vars, overlaid on the daemon's inherited environment.
    pub env: HashMap<String, String>,
    /// Cap on buffered output kept in memory for `output`.
    pub output_byte_limit: Option<usize>,
}

/// Exit status of a tracked terminal.
///
/// `PtyHandle` exposes child exit only as a boolean (`is_exited`), not the exit
/// code / signal — so `exited` is the ported observable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalExitStatus {
    /// True once the child has exited (terminal).
    pub exited: bool,
}

/// Buffered output for `terminal/output`.
#[derive(Debug, Clone, Default)]
pub struct TerminalOutput {
    pub output: String,
    pub truncated: bool,
}

/// Failure modes for the ACP terminal manager.
#[derive(Debug, thiserror::Error)]
pub enum AcpTerminalError {
    #[error("unknown terminalId: {0}")]
    UnknownTerminal(String),
    #[error("failed to spawn terminal process: {0}")]
    Spawn(String),
}

const DEFAULT_OUTPUT_BYTE_LIMIT: usize = 1_000_000;

/// Buffered output state for one tracked terminal.
#[derive(Debug)]
struct OutputState {
    chunks: Vec<String>,
    bytes: usize,
    truncated: bool,
    limit: usize,
}

impl OutputState {
    fn new(limit: usize) -> Self {
        Self {
            chunks: Vec::new(),
            bytes: 0,
            truncated: false,
            limit,
        }
    }

    fn push(&mut self, chunk: &str) {
        self.bytes += chunk.len();
        self.chunks.push(chunk.to_string());
        if self.bytes > self.limit {
            self.truncated = true;
            // Keep only the tail within the limit.
            let mut kept: Vec<String> = Vec::new();
            let mut total = 0usize;
            for c in self.chunks.iter().rev() {
                total += c.len();
                kept.push(c.clone());
                if total >= self.limit {
                    break;
                }
            }
            kept.reverse();
            self.chunks = kept;
            self.bytes = total;
        }
    }

    fn render(&self) -> TerminalOutput {
        TerminalOutput {
            output: self.chunks.concat(),
            truncated: self.truncated,
        }
    }
}

#[derive(Debug)]
struct Tracked {
    handle: PtyHandle,
    output: Arc<Mutex<OutputState>>,
}

/// Manages host-owned background terminals created by the wrapped CLI.
#[derive(Debug, Default, Clone)]
pub struct TerminalManager {
    terminals: Arc<Mutex<HashMap<String, Arc<Tracked>>>>,
}

impl TerminalManager {
    /// True while at least one tracked child is still running (Decision 4's
    /// idle-TTL veto).
    pub fn has_live_terminals(&self) -> bool {
        let map = self.terminals.lock().unwrap();
        map.values().any(|t| !t.handle.is_exited())
    }

    /// Create a background terminal and return its id. The child is spawned
    /// detached (via `vst-proc`'s `spawn_child`) and buffered until released.
    pub fn create(
        &self,
        params: TerminalCreateParams,
        session_id: &str,
        project_id: &str,
        worktree_id: Option<&str>,
    ) -> String {
        let terminal_id = terminal_id();
        let cwd = params
            .cwd
            .clone()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));
        let handle = spawn_child(SpawnChildOptions {
            command: params.command.clone(),
            args: params.args.clone(),
            cwd,
            env: params.env.clone(),
            cols: 80,
            rows: 24,
            session_id: session_id.to_string(),
            project_id: project_id.to_string(),
            worktree_id: worktree_id.map(str::to_string),
        })
        .expect("spawn_child must succeed for a valid launch spec");
        let limit = params
            .output_byte_limit
            .unwrap_or(DEFAULT_OUTPUT_BYTE_LIMIT);
        let output = Arc::new(Mutex::new(OutputState::new(limit)));

        // Drain live output chunks into the shared buffer. The task ends when
        // the PtyHandle is dropped (the chunk broadcast closes).
        {
            let mut rx = handle.on_chunk();
            let out = Arc::clone(&output);
            tokio::spawn(async move {
                while let Ok(chunk) = rx.recv().await {
                    out.lock().unwrap().push(&chunk);
                }
            });
        }

        let tracked = Arc::new(Tracked { handle, output });
        self.terminals
            .lock()
            .unwrap()
            .insert(terminal_id.clone(), tracked);
        terminal_id
    }

    /// Buffered output for a terminal (or `UnknownTerminal` error).
    pub fn output(&self, terminal_id: &str) -> Result<TerminalOutput, AcpTerminalError> {
        let tracked = self.require(terminal_id)?;
        let out = tracked.output.lock().unwrap().render();
        Ok(out)
    }

    /// Resolve once the tracked child has exited.
    pub async fn wait_for_exit(
        &self,
        terminal_id: &str,
    ) -> Result<TerminalExitStatus, AcpTerminalError> {
        let handle = {
            let tracked = self.require(terminal_id)?;
            tracked.handle.clone()
        };
        let mut rx = handle.on_close();
        if handle.is_exited() {
            return Ok(TerminalExitStatus { exited: true });
        }
        // A live terminal: wait for the close event (fired once on exit).
        let _ = rx.recv().await;
        Ok(TerminalExitStatus { exited: true })
    }

    /// Force-stop a live child (no-op if already exited).
    pub fn kill(&self, terminal_id: &str) {
        if let Ok(tracked) = self.require(terminal_id) {
            tracked.handle.kill();
        }
    }

    /// Remove a terminal from tracking; force-stops it if still running.
    pub fn release(&self, terminal_id: &str) {
        let removed = self.terminals.lock().unwrap().remove(terminal_id);
        if let Some(tracked) = removed {
            if !tracked.handle.is_exited() {
                tracked.handle.kill();
            }
        }
    }

    /// Teardown — hard-kill every tracked terminal (connection dispose).
    pub fn kill_all(&self) {
        let ids: Vec<String> = self.terminals.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.release(&id);
        }
    }

    fn require(&self, terminal_id: &str) -> Result<Arc<Tracked>, AcpTerminalError> {
        self.terminals
            .lock()
            .unwrap()
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| AcpTerminalError::UnknownTerminal(terminal_id.to_string()))
    }
}

/// A monotonically-increasing, roughly-unique terminal id (`term-<n>-<ts>`).
fn terminal_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("term-{n}-{ts}")
}
