//! Tmux command wrappers (ports `services/tmux.ts`).
//!
//! All functions invoke `tmux` via a subprocess with each argument passed
//! directly as an argv element — no shell quoting, no ARG_MAX issues with large
//! prompts (the same choice the TS `execFile` makes).
//!
//! The [`Tmux`] struct carries an optional socket name (`-L <socket>`). The
//! default (`Tmux::new()`) runs bare `tmux` against the user's default server,
//! exactly like the TS. A socket-named instance is used by tests to isolate
//! against a dedicated server so they never clobber a live user session.

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;

use crate::error::TmuxError;

/// Classification of a `tmux list-sessions` failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListErrorClass {
    /// tmux reports nothing is running at all ("no server running", "error
    /// connecting to", "No such file or directory") — authoritative: every
    /// session really is gone, so the caller may act on an empty set.
    NoServer,
    /// Any other failure — the caller cannot interpret it and should skip the
    /// tick rather than assume every session died.
    Uninterpretable,
}

/// Parse the stdout of `tmux list-sessions -F "#{session_name}"` into a set of
/// live session names. Empty lines are dropped.
pub fn parse_list_sessions_output(stdout: &str) -> HashSet<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// Classify a `tmux list-sessions` stderr string.
pub fn classify_list_sessions_error(stderr: &str) -> ListErrorClass {
    let text = stderr.to_ascii_lowercase();
    if text.contains("no server running")
        || text.contains("error connecting to")
        || text.contains("no such file or directory")
    {
        ListErrorClass::NoServer
    } else {
        ListErrorClass::Uninterpretable
    }
}

/// Options for `tmux new-session -d`.
#[derive(Debug, Clone, Default)]
pub struct NewSessionOptions {
    /// Session name (`-s <name>`).
    pub name: String,
    /// Working directory (`-c <cwd>`).
    pub cwd: Option<PathBuf>,
    /// Extra environment, each `KEY=VALUE` passed as `-e KEY=VALUE`.
    pub env: std::collections::HashMap<String, String>,
    /// Command + args to run as the initial command (must be the last argv).
    pub command: Option<Vec<String>>,
}

/// Options for `tmux capture-pane`.
#[derive(Debug, Clone, Default)]
pub struct CapturePaneOptions {
    /// Include escape sequences (`-e`).
    pub escape: bool,
    /// Number of lines to capture (`-S -<lines>`). If `None`, not passed.
    pub lines: Option<usize>,
}

/// A handle to invoke `tmux` commands.
#[derive(Debug, Clone, Default)]
pub struct Tmux {
    /// Optional `-L <socket>` name; `None` runs bare `tmux`.
    socket: Option<String>,
}

impl Tmux {
    /// A client against the default tmux server (bare `tmux`), matching the TS.
    pub fn new() -> Self {
        Self::default()
    }

    /// A client pinned to a named server socket (`-L <name>`), for isolation.
    pub fn with_socket(socket: impl Into<String>) -> Self {
        Self {
            socket: Some(socket.into()),
        }
    }

    /// Run `tmux` with the given argv, returning trimmed stdout.
    ///
    /// Env is inherited from the daemon process (PATH, HOME, SHELL, NVM bits,
    /// etc.) so shell launchers can resolve binaries like `claude`.
    fn run(&self, args: &[&str]) -> Result<String, TmuxError> {
        let mut cmd = Command::new("tmux");
        if let Some(sock) = &self.socket {
            cmd.arg("-L").arg(sock);
        }
        cmd.args(args);

        let out = cmd.output().map_err(|e| TmuxError {
            args: args.join(" "),
            stderr: format!("io: {e}"),
        })?;
        if !out.status.success() {
            return Err(TmuxError {
                args: args.join(" "),
                stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// True if the named tmux session exists. A failing `has-session` (session
    /// absent, or server down) is `false`.
    pub fn has_session(&self, name: &str) -> bool {
        self.run(&["has-session", "-t", name]).is_ok()
    }

    /// Kill a tmux session by name. Best-effort — does not error if absent.
    pub fn kill_session(&self, name: &str) {
        let _ = self.run(&["kill-session", "-t", name]);
    }

    /// Kill the whole (isolated) tmux server this client points at.
    pub fn kill_server(&self) {
        let _ = self.run(&["kill-server"]);
    }

    /// Create a new detached tmux session.
    pub fn new_session(&self, opts: &NewSessionOptions) -> Result<(), TmuxError> {
        let mut args: Vec<String> = vec![
            "new-session".to_string(),
            "-d".to_string(),
            "-s".to_string(),
            opts.name.clone(),
        ];
        if let Some(cwd) = &opts.cwd {
            args.push("-c".to_string());
            args.push(cwd.to_string_lossy().into_owned());
        }
        for (k, v) in &opts.env {
            args.push("-e".to_string());
            args.push(format!("{k}={v}"));
        }
        if let Some(command) = &opts.command {
            if !command.is_empty() {
                // Command must be the last argument.
                args.extend(command.iter().cloned());
            }
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run(&refs)?;
        Ok(())
    }

    /// Send keys to a tmux session/pane, optionally followed by `Enter`.
    pub fn send_keys(&self, target: &str, keys: &str, enter: bool) -> Result<(), TmuxError> {
        let mut args = vec!["send-keys", "-t", target, keys];
        if enter {
            args.push("Enter");
        }
        self.run(&args)?;
        Ok(())
    }

    /// Capture pane output from a tmux session.
    pub fn capture_pane(
        &self,
        target: &str,
        opts: &CapturePaneOptions,
    ) -> Result<String, TmuxError> {
        let mut args: Vec<String> = vec![
            "capture-pane".to_string(),
            "-p".to_string(),
            "-t".to_string(),
            target.to_string(),
        ];
        if opts.escape {
            args.push("-e".to_string());
        }
        if let Some(lines) = opts.lines {
            args.push("-S".to_string());
            args.push(format!("-{}", lines));
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run(&refs)
    }

    /// List all tmux sessions, returning their names. Errors collapse to `[]`.
    pub fn list_sessions(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .list_session_names()
            .map(|s| s.into_iter().collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    /// Names of every live tmux session as a set — or `None` if tmux failed for
    /// a reason we cannot interpret.
    ///
    /// The `None` case matters: the lifecycle poller uses this snapshot to
    /// decide which sessions are still alive, so an error silently collapsing
    /// to "empty" would mark EVERY session exited in one tick. "No server
    /// running" is the one failure that genuinely means "nothing is alive", so
    /// it maps to an empty set; anything else maps to `None` and the caller
    /// skips.
    pub fn list_session_names(&self) -> Option<HashSet<String>> {
        match self.run(&["list-sessions", "-F", "#{session_name}"]) {
            Ok(stdout) => Some(parse_list_sessions_output(&stdout)),
            Err(e) => match classify_list_sessions_error(e.stderr()) {
                ListErrorClass::NoServer => Some(HashSet::new()),
                ListErrorClass::Uninterpretable => {
                    tracing::warn!(
                        "[tmux] list-sessions failed, skipping liveness check: {}",
                        e.stderr().trim()
                    );
                    None
                }
            },
        }
    }

    /// Load `data` into a named tmux buffer via a temp file and paste it into
    /// the target pane. Avoids the shell argument-length limit `send-keys`
    /// hits with large prompts.
    ///
    /// `-p` enables bracketed paste (`\e[200~`/`\e[201~`), which TUI editors
    /// honour and treat as a paste rather than individual keystrokes — so
    /// embedded newlines stay in the editor instead of being submitted as
    /// separate messages.
    pub fn paste_buffer(&self, target: &str, buffer_id: &str, data: &str) -> Result<(), TmuxError> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let tmp_file = format!("/tmp/vr-buf-{buffer_id}-{nanos}");

        let result = (|| -> Result<(), TmuxError> {
            std::fs::write(&tmp_file, data).map_err(|e| TmuxError {
                args: "load-buffer".to_string(),
                stderr: format!("write tmp file: {e}"),
            })?;
            self.run(&["load-buffer", "-b", buffer_id, &tmp_file])?;
            self.run(&["paste-buffer", "-b", buffer_id, "-d", "-p", "-t", target])?;
            Ok(())
        })();

        // Best-effort cleanup regardless of success.
        let _ = std::fs::remove_file(&tmp_file);
        result
    }
}
