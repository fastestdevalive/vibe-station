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

use std::collections::{HashMap, HashSet};
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

/// Session-level exact target (`=name`) for `has-session`, `kill-session` and
/// `attach-session`. A bare name prefix-matches another session (`ab` -> `abc`).
pub fn exact_session(name: &str) -> String {
    format!("={name}")
}

/// Window/pane-level exact target (`=name:`) for `display-message`,
/// `capture-pane`, `send-keys`, `paste-buffer`, `resize-window`, `set-option`.
/// These reject the bare `=name` form, so the trailing colon is mandatory.
pub fn exact_pane(name: &str) -> String {
    format!("={name}:")
}

/// `set-option -w -t =name: remain-on-exit on` (window option; never `-g`).
fn remain_on_exit_args(name: &str) -> [String; 6] {
    [
        "set-option",
        "-w",
        "-t",
        &exact_pane(name),
        "remain-on-exit",
        "on",
    ]
    .map(str::to_string)
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
    /// Keep the session (with a dead pane) after the pane command exits, so the
    /// exit status/signal can be read. Set per session (never `-g`) by a
    /// `set-option` chained after `new-session` in the SAME tmux invocation, so
    /// it is in place before the server can see the pane exit. tmux skips it
    /// when `new-session` itself fails, and splits commands at an argv element ending in
    /// `;`, with or without the chain, so `command` must not rely on one.
    pub remain_on_exit: bool,
}

/// Exit state of a session's active pane, from `#{pane_dead}` and friends.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionPaneInfo {
    /// `#{pane_dead}`: the pane command exited (session kept by `remain-on-exit`).
    pub dead: bool,
    /// `#{pane_dead_status}`: exit status, when the command exited normally.
    pub dead_status: Option<i32>,
    /// `#{pane_dead_signal}`: lowercase signal name (`term`, `kill`, ...), when
    /// the command was killed by a signal. Needs tmux >= 3.3.
    pub dead_signal: Option<String>,
}

/// Bounded re-reads (about 0.5 s total) for a dead pane whose exit status has
/// not been reaped yet; see [`Tmux::pane_exit_info`].
const PANE_STATUS_SETTLE_TRIES: u32 = 10;
const PANE_STATUS_SETTLE_DELAY: Duration = Duration::from_millis(50);

/// Format for [`Tmux::list_session_panes`] / [`Tmux::pane_exit_info`].
const PANE_INFO_FORMAT: &str = "#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}";

/// Parse the `dead|status|signal` tail of a pane-info line.
fn parse_pane_info(dead: &str, status: &str, signal: &str) -> Option<SessionPaneInfo> {
    let dead = match dead {
        "0" => false,
        "1" => true,
        _ => return None,
    };
    let status = status.trim();
    let signal = signal.trim();
    Some(SessionPaneInfo {
        dead,
        dead_status: if status.is_empty() {
            None
        } else {
            Some(status.parse().ok()?)
        },
        dead_signal: (!signal.is_empty()).then(|| normalize_signal(signal)),
    })
}

/// tmux builds differ: macOS tmux 3.8 prints the signal as a name (`term`),
/// the Linux builds in CI print its number (`15`). Store one spelling — the
/// lowercase name when the number is a known signal, else the raw text.
fn normalize_signal(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    match lower.parse::<i32>() {
        Ok(n) => SIGNALS
            .iter()
            .find(|(_, num)| *num == n)
            .map_or(lower, |(name, _)| (*name).to_string()),
        Err(_) => lower,
    }
}

/// Parse `list-sessions -F '#{session_name}|<pane info>'` output. The session
/// name is everything before the last three `|` separators, so a name
/// containing `|` still parses. A listed line is always *present*: one whose
/// pane info cannot be parsed counts as present and alive (never as vanished),
/// so a parse quirk can never make a live session look gone.
pub fn parse_list_session_panes(stdout: &str) -> HashMap<String, SessionPaneInfo> {
    let mut map = HashMap::new();
    let mut fallbacks = 0usize;
    for line in stdout.lines() {
        let parts: Vec<&str> = line.rsplitn(4, '|').collect();
        // rsplitn yields [signal, status, dead, name].
        if let [signal, status, dead, name] = parts.as_slice() {
            if name.is_empty() {
                continue;
            }
            match parse_pane_info(dead, status, signal) {
                Some(info) => {
                    map.insert((*name).to_string(), info);
                }
                None => {
                    fallbacks += 1;
                    map.insert((*name).to_string(), SessionPaneInfo::default());
                }
            }
        } else {
            let name = line.trim();
            if !name.is_empty() {
                fallbacks += 1;
                map.insert(name.to_string(), SessionPaneInfo::default());
            }
        }
    }
    if fallbacks > 0 {
        tracing::warn!(
            lines = fallbacks,
            "tmux list-sessions: unparseable pane info treated as present and alive"
        );
    }
    map
}

const SIGNALS: [(&str, i32); 9] = [
    ("hup", 1),
    ("int", 2),
    ("quit", 3),
    ("abrt", 6),
    ("kill", 9),
    ("segv", 11),
    ("pipe", 13),
    ("alrm", 14),
    ("term", 15),
];

fn signal_number(name: &str) -> Option<i32> {
    SIGNALS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, num)| *num)
        .or_else(|| name.parse().ok())
}

/// Human description of why a pane died. Never blank.
pub fn describe_exit(info: &SessionPaneInfo) -> String {
    if let Some(sig) = info.dead_signal.as_deref().filter(|s| !s.is_empty()) {
        let upper = sig.to_ascii_uppercase();
        return match signal_number(sig) {
            Some(n) if upper != n.to_string() => format!("killed by signal {n} ({upper})"),
            Some(n) => format!("killed by signal {n}"),
            None => format!("killed by signal {upper}"),
        };
    }
    match info.dead_status {
        Some(0) => "exited normally (status 0)".to_string(),
        Some(n) if (129..=192).contains(&n) => {
            format!(
                "exited with status {n} (likely killed by signal {})",
                n - 128
            )
        }
        Some(n) => format!("exited with status {n}"),
        None => "pane exited".to_string(),
    }
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
        self.run(&["has-session", "-t", &exact_session(name)])
            .is_ok()
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
        self.run(&[
            "display-message",
            "-p",
            "-t",
            &exact_pane(name),
            "#{pane_dead}",
        ])
        .map(|out| out.trim() == "0")
        .unwrap_or(false)
    }

    /// Kill a tmux session by name. Best-effort — does not error if absent.
    pub fn kill_session(&self, name: &str) {
        let _ = self.run(&["kill-session", "-t", &exact_session(name)]);
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
        if opts.remain_on_exit {
            // Chained onto the same tmux invocation (`new-session ... ; set-option`),
            // so the server runs both before it can notice the pane exiting. As two
            // invocations, a command that exits at once (the launch failure most
            // worth explaining) took its session with it before the option landed.
            args.push(";".to_string());
            args.extend(remain_on_exit_args(&opts.name));
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run(&refs)?;
        Ok(())
    }

    /// Per-session `remain-on-exit on` (a window option in tmux >= 3.x, set on
    /// the session's window via `-w`; never `-g`).
    pub fn set_remain_on_exit(&self, name: &str) -> Result<(), TmuxError> {
        let args = remain_on_exit_args(name);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run(&refs)?;
        Ok(())
    }

    /// Kill the session only if its pane is still dead, atomically server-side
    /// (`if-shell -F`), so a same-name session re-created live in between
    /// survives. Best-effort.
    pub fn kill_session_if_dead(&self, name: &str) {
        let _ = self.run(&[
            "if-shell",
            "-F",
            "-t",
            &exact_pane(name),
            "#{pane_dead}",
            &format!("kill-session -t {}", exact_session(name)),
        ]);
    }

    /// Fresh single read of a session's active-pane exit state. `None` = the
    /// session is missing or the output is not understood (never "dead").
    ///
    /// tmux flips `pane_dead` when the pane's PTY closes, but fills in the exit
    /// status/signal only once it has reaped the child — under load the gap is
    /// visible. A dead pane that has neither yet is re-read for a short, bounded
    /// time so the poller never records a bare "pane exited" (and then kills the
    /// session) for a pane whose real reason lands a few milliseconds later. If
    /// the first wait does not help, the server is nudged ([`Self::nudge_reap`]).
    pub fn pane_exit_info(&self, name: &str) -> Option<SessionPaneInfo> {
        let mut info = self.pane_exit_info_once(name)?;
        for attempt in 0..PANE_STATUS_SETTLE_TRIES {
            if !info.dead || info.dead_status.is_some() || info.dead_signal.is_some() {
                break;
            }
            if attempt > 0 {
                self.nudge_reap();
            }
            std::thread::sleep(PANE_STATUS_SETTLE_DELAY);
            info = self.pane_exit_info_once(name)?;
        }
        Some(info)
    }

    /// Make the server reap its children now. tmux 3.3a under load can miss the
    /// SIGCHLD of a pane's command: the pane reads dead, the child stays a
    /// zombie and the status never arrives by waiting alone. Any later child
    /// exit makes the server reap everything, so run a no-op job. Best-effort.
    fn nudge_reap(&self) {
        let _ = self.run(&["run-shell", "true"]);
    }

    fn pane_exit_info_once(&self, name: &str) -> Option<SessionPaneInfo> {
        let out = self
            .run(&[
                "display-message",
                "-p",
                "-t",
                &exact_pane(name),
                PANE_INFO_FORMAT,
            ])
            .ok()?;
        let mut it = out.trim().splitn(3, '|');
        parse_pane_info(it.next()?, it.next()?, it.next()?)
    }

    /// Exit state of every session's ACTIVE pane in one call (same NoServer /
    /// uninterpretable semantics as [`Self::list_session_names`]).
    ///
    /// Known limitation: only the active pane is read. Agent sessions are one
    /// window / one pane; a user-split pane can hide the agent's death.
    pub fn list_session_panes(&self) -> Option<HashMap<String, SessionPaneInfo>> {
        let format = format!("#{{session_name}}|{PANE_INFO_FORMAT}");
        match self.run(&["list-sessions", "-F", &format]) {
            Ok(stdout) => Some(parse_list_session_panes(&stdout)),
            Err(e) => match classify_list_sessions_error(e.stderr()) {
                ListErrorClass::NoServer => Some(HashMap::new()),
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
