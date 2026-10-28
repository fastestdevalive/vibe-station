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
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

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
    /// Per-call bound; `None` = [`TMUX_CALL_TIMEOUT`].
    call_timeout: Option<Duration>,
}

/// Upper bound for one tmux invocation. tmux answers in milliseconds; a call
/// that outlives this is hung (wedged server, stuck pty) and is killed.
pub const TMUX_CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// `wait_with_output` with a deadline: stdout/stderr are drained on their own
/// threads (a full pipe must not stall the child), and a child still running at
/// the deadline is killed and reaped. The error is `TimedOut`.
fn wait_bounded(mut child: Child, timeout: Duration) -> std::io::Result<Output> {
    fn drain(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    }
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    // Start with a sub-millisecond nap (tmux usually answers at once) and back
    // off to 5 ms, so a quick call costs no fixed 5 ms floor.
    let mut nap = Duration::from_micros(250);
    let status = loop {
        if let Some(st) = child.try_wait()? {
            break st;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            // The readers end when the pipes close; do not wait on a grandchild
            // that kept them open.
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("tmux did not finish within {timeout:?}"),
            ));
        }
        std::thread::sleep(nap);
        nap = (nap * 2).min(Duration::from_millis(5));
    };
    Ok(Output {
        status,
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

/// Map a finished tmux process to trimmed stdout or a [`TmuxError`].
fn finish(args: &[&str], out: &std::process::Output) -> Result<String, TmuxError> {
    if !out.status.success() {
        return Err(TmuxError {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Process-wide suffix so two pastes with the same caller `buffer_id` never
/// share a tmux buffer.
static BUFFER_SEQ: AtomicU64 = AtomicU64::new(0);

/// Pane state read by one `display -p`: copy-mode and dead-pane flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneFlags {
    /// `#{pane_in_mode}`: the pane is in copy/view mode (the web terminal
    /// enters copy-mode on scroll), where `Enter` is swallowed.
    pub in_mode: bool,
    /// `#{pane_dead}`: the pane's command exited but `remain-on-exit` keeps
    /// the session listed.
    pub dead: bool,
}

/// Parse the `"<in_mode> <dead>"` output of the `pane_flags` format.
pub fn parse_pane_flags(out: &str) -> Option<PaneFlags> {
    let mut it = out.split_whitespace();
    let in_mode = it.next()?;
    let dead = it.next()?;
    if it.next().is_some() {
        return None;
    }
    let flag = |v: &str| match v {
        "0" => Some(false),
        "1" => Some(true),
        _ => None,
    };
    Some(PaneFlags {
        in_mode: flag(in_mode)?,
        dead: flag(dead)?,
    })
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
            call_timeout: None,
        }
    }

    /// Override the per-call timeout (tests use a short one).
    pub fn with_call_timeout(mut self, t: Duration) -> Self {
        self.call_timeout = Some(t);
        self
    }

    fn timeout(&self) -> Duration {
        self.call_timeout.unwrap_or(TMUX_CALL_TIMEOUT)
    }

    /// Spawn with piped output and wait for it, bounded.
    fn output_bounded(&self, args: &[&str]) -> std::io::Result<Output> {
        let child = self
            .command(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        wait_bounded(child, self.timeout())
    }

    /// Run `tmux` with the given argv, returning trimmed stdout.
    ///
    /// Env is inherited from the daemon process (PATH, HOME, SHELL, NVM bits,
    /// etc.) so shell launchers can resolve binaries like `claude`.
    fn run(&self, args: &[&str]) -> Result<String, TmuxError> {
        let out = self.output_bounded(args).map_err(|e| TmuxError {
            args: args.join(" "),
            stderr: format!("io: {e}"),
        })?;
        finish(args, &out)
    }

    /// Like [`Self::run`] but feeds `data` to the child's stdin.
    ///
    /// Order matters: the writer runs on its own thread and drops (closes)
    /// stdin when done, and only then does the parent `wait`. Writing inline
    /// would deadlock once `data` exceeds the pipe buffer while tmux is still
    /// blocked writing its own output.
    fn run_with_stdin(&self, args: &[&str], data: &[u8]) -> Result<String, TmuxError> {
        let io_err = |e: std::io::Error| TmuxError {
            args: args.join(" "),
            stderr: format!("io: {e}"),
        };
        let mut child = self
            .command(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(io_err)?;
        let Some(mut stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(TmuxError {
                args: args.join(" "),
                stderr: "io: child stdin was not piped".to_string(),
            });
        };
        let payload = data.to_vec();
        // A write error (child exited early) surfaces through its exit status.
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(&payload);
        });
        let out = wait_bounded(child, self.timeout());
        // The writer ends once the child is gone (EPIPE) or has read it all.
        let _ = writer.join();
        finish(args, &out.map_err(io_err)?)
    }

    /// The `tmux [-L socket] <args>` command, env inherited.
    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new("tmux");
        if let Some(sock) = &self.socket {
            cmd.arg("-L").arg(sock);
        }
        cmd.args(args);
        cmd
    }

    /// True if the named tmux session exists. A failing `has-session` (session
    /// absent, or server down) is `false`.
    pub fn has_session(&self, name: &str) -> bool {
        self.run(&["has-session", "-t", name]).is_ok()
    }

    /// True if the session's pane is still running its command.
    ///
    /// Deliberately NOT `has_session`: a user's `~/.tmux.conf` can set
    /// `remain-on-exit on`, which keeps the *session* alive after its pane's
    /// command exits (the pane is then "dead"). For readiness/liveness checks
    /// that would report a crashed CLI as a successful launch.
    ///
    /// `false` when the session is gone or the probe fails.
    pub fn pane_is_alive(&self, name: &str) -> bool {
        self.run(&["display-message", "-p", "-t", name, "#{pane_dead}"])
            .map(|out| out.trim() == "0")
            .unwrap_or(false)
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

    /// Load `data` into a unique named tmux buffer through stdin (no temp
    /// file) and paste it into the target pane. Avoids the shell
    /// argument-length limit `send-keys` hits with large prompts and the
    /// predictable world-readable `/tmp` file the old implementation wrote.
    ///
    /// `-p` enables bracketed paste (`\e[200~`/`\e[201~`), which TUI editors
    /// honour and treat as a paste rather than individual keystrokes — so
    /// embedded newlines stay in the editor instead of being submitted as
    /// separate messages. Equivalent to
    /// [`paste_buffer_with`](Self::paste_buffer_with) with `raw_lf = false`.
    pub fn paste_buffer(&self, target: &str, buffer_id: &str, data: &str) -> Result<(), TmuxError> {
        self.paste_buffer_with(target, buffer_id, data, false)
    }

    /// [`paste_buffer`](Self::paste_buffer) with control over LF handling:
    /// `raw_lf = true` passes `-r` so LF is not converted to CR by tmux.
    ///
    /// The tmux buffer name is `<buffer_id>-<pid>-<seq>`, unique per call, and
    /// is deleted best-effort when the paste fails (`-d` deletes it on success).
    /// `target` is passed verbatim: callers that must not prefix-match use the
    /// exact form `=<name>:`.
    pub fn paste_buffer_with(
        &self,
        target: &str,
        buffer_id: &str,
        data: &str,
        raw_lf: bool,
    ) -> Result<(), TmuxError> {
        let seq = BUFFER_SEQ.fetch_add(1, Ordering::Relaxed);
        let name = format!("{buffer_id}-{}-{seq}", std::process::id());
        self.run_with_stdin(&["load-buffer", "-b", &name, "-"], data.as_bytes())?;
        let mut args = vec!["paste-buffer", "-b", &name, "-d", "-p"];
        if raw_lf {
            args.push("-r");
        }
        args.extend(["-t", target]);
        if let Err(e) = self.run(&args) {
            let _ = self.run(&["delete-buffer", "-b", &name]);
            return Err(e);
        }
        Ok(())
    }

    /// One `display -p` of copy-mode and dead-pane state for `target`.
    ///
    /// `None` = the target is missing or the output is not understood; callers
    /// treat that as "unknown, try again", never as "dead".
    pub fn pane_flags(&self, target: &str) -> Option<PaneFlags> {
        self.run(&[
            "display-message",
            "-p",
            "-t",
            target,
            "#{pane_in_mode} #{pane_dead}",
        ])
        .ok()
        .and_then(|out| parse_pane_flags(&out))
    }

    /// The visible screen of `target` exactly as tmux prints it (`capture-pane
    /// -p`, no scrollback, stdout NOT trimmed): leading blank rows are kept so
    /// line indices match [`pane_cursor`](Self::pane_cursor)'s row.
    pub fn capture_screen(&self, target: &str) -> Result<String, TmuxError> {
        let args = ["capture-pane", "-p", "-t", target];
        let out = self.output_bounded(&args).map_err(|e| TmuxError {
            args: args.join(" "),
            stderr: format!("io: {e}"),
        })?;
        if !out.status.success() {
            return Err(TmuxError {
                args: args.join(" "),
                stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// 0-based `(cursor_x, cursor_y)` on the visible screen of `target`;
    /// `None` when the target is missing or the output is not understood.
    pub fn pane_cursor(&self, target: &str) -> Option<(u16, u16)> {
        let out = self
            .run(&[
                "display-message",
                "-p",
                "-t",
                target,
                "#{cursor_x} #{cursor_y}",
            ])
            .ok()?;
        let mut it = out.split_whitespace();
        let x = it.next()?.parse().ok()?;
        let y = it.next()?.parse().ok()?;
        if it.next().is_some() {
            return None;
        }
        Some((x, y))
    }

    /// Press `Enter` in `target` (no other keys).
    pub fn send_enter(&self, target: &str) -> Result<(), TmuxError> {
        self.run(&["send-keys", "-t", target, "Enter"])?;
        Ok(())
    }

    /// Leave copy/view mode (`send-keys -X cancel`). Errors when the pane is
    /// not in a mode, so callers check [`pane_flags`](Self::pane_flags) first.
    pub fn cancel_mode(&self, target: &str) -> Result<(), TmuxError> {
        self.run(&["send-keys", "-t", target, "-X", "cancel"])?;
        Ok(())
    }
}

#[cfg(test)]
mod wait_bounded_tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn quick_children_do_not_pay_a_fixed_floor() {
        let start = Instant::now();
        for _ in 0..20 {
            let child = Command::new("true")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            assert!(wait_bounded(child, Duration::from_secs(5))
                .unwrap()
                .status
                .success());
        }
        assert!(
            start.elapsed() < Duration::from_millis(1500),
            "{:?}",
            start.elapsed()
        );
    }
}
