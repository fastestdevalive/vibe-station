//! Owns one `agy --input-format stream-json --output-format stream-json`
//! child process: spawning, argv, stdout parsing, the bounded/redacted stderr
//! ring, and signalling.
//!
//! **Process group:** agy is deliberately NOT put in its own process group
//! (`process_group(0)`/`setsid` would detach it) — it must stay in the agent's
//! group so the daemon's group kill on `dispose()` takes it down too.
//!
//! **No `unsafe`:** signalling goes through `kill -INT|-KILL <pid>`, which is
//! why this crate can stay `#![forbid(unsafe_code)]`.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Notify};

use crate::wire::{parse_line, user_event, Inbound};

/// Last-N-lines / N-bytes window kept for diagnostics.
const STDERR_MAX_LINES: usize = 50;
const STDERR_MAX_BYTES: usize = 4096;

/// Which signal to send. SIGTERM is never used by this crate: a real agy emits
/// a stray `result{ERROR,"stream input cancelled"}` on SIGTERM, and mid-turn
/// cancellation is SIGINT.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Int,
    Kill,
}

/// How to start agy for one session.
#[derive(Debug, Clone)]
pub struct SpawnOpts {
    pub agy_bin: String,
    /// agy runs IN the session's cwd (never the daemon's).
    pub cwd: PathBuf,
    /// `--conversation <id>` when resuming; `None` for a fresh conversation.
    pub conversation: Option<String>,
    pub model: Option<String>,
}

/// A failure to start agy or to reach its `init`.
#[derive(Debug, Clone)]
pub enum SpawnError {
    /// The binary could not be started (missing / not executable).
    Spawn { bin: String, detail: String },
    /// agy started but never reported `init` (timeout, early exit, no id).
    NoInit { detail: String, stderr_tail: String },
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn { bin, detail } => {
                write!(f, "could not start agy binary \"{bin}\": {detail}")
            }
            Self::NoInit {
                detail,
                stderr_tail,
            } => {
                write!(f, "agy did not initialise: {detail}")?;
                if !stderr_tail.is_empty() {
                    write!(f, "; stderr: {stderr_tail}")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for SpawnError {}

/// One live agy process plus its parsed-stdout channel and stderr window.
#[derive(Debug)]
pub struct AgyProcess {
    child: Child,
    stdin: Option<tokio::process::ChildStdin>,
    inbound: mpsc::UnboundedReceiver<Inbound>,
    stderr: Arc<Mutex<StderrRing>>,
    /// Signalled once the stderr reader has drained to EOF — lets the exit
    /// path wait (briefly) for the last lines instead of racing the reader.
    stderr_closed: Arc<Notify>,
    live_pid: Arc<AtomicU32>,
    pid: u32,
}

impl AgyProcess {
    /// Spawn agy and start the stdout/stderr readers.
    ///
    /// `live_pid` is shared with the agent so `session/cancel` can SIGINT the
    /// current process without holding the session state lock (the prompt task
    /// owns the process for the duration of a turn).
    ///
    /// # Errors
    ///
    /// [`SpawnError::Spawn`] when the binary cannot be started or its stdio
    /// pipes are unavailable.
    pub fn spawn(opts: &SpawnOpts, live_pid: Arc<AtomicU32>) -> Result<Self, SpawnError> {
        let mut cmd = Command::new(&opts.agy_bin);
        cmd.arg("--input-format")
            .arg("stream-json")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--print=")
            // stream-json has no permission channel; parity with the terminal
            // launch. Denied actions are still surfaced (see `map.rs`).
            .arg("--dangerously-skip-permissions");
        if let Some(conversation) = &opts.conversation {
            cmd.arg("--conversation").arg(conversation);
        }
        if let Some(model) = &opts.model {
            if !model.is_empty() {
                cmd.arg("--model").arg(model);
            }
        }
        cmd.current_dir(&opts.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|error| SpawnError::Spawn {
            bin: opts.agy_bin.clone(),
            detail: error.to_string(),
        })?;
        let pid = child.id().unwrap_or(0);
        live_pid.store(pid, Ordering::SeqCst);

        let (Some(stdout), Some(stderr_pipe)) = (child.stdout.take(), child.stderr.take()) else {
            let _ = child.start_kill();
            live_pid.store(0, Ordering::SeqCst);
            return Err(SpawnError::Spawn {
                bin: opts.agy_bin.clone(),
                detail: "agy stdio pipes unavailable".to_string(),
            });
        };
        let stdin = child.stdin.take();

        let (tx, inbound) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::new();
            while let Some(line) = next_lossy_line(&mut reader, &mut buf).await {
                if let Some(event) = parse_line(&line) {
                    if tx.send(event).is_err() {
                        break;
                    }
                }
            }
            // Dropping `tx` closes the channel: `recv()` then yields `None`,
            // which the agent treats as "agy exited".
        });

        let stderr = Arc::new(Mutex::new(StderrRing::default()));
        let stderr_closed = Arc::new(Notify::new());
        let ring = Arc::clone(&stderr);
        let closed = Arc::clone(&stderr_closed);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr_pipe);
            let mut buf = Vec::new();
            while let Some(line) = next_lossy_line(&mut reader, &mut buf).await {
                // std Mutex, never held across an await.
                if let Ok(mut ring) = ring.lock() {
                    ring.push(line);
                }
            }
            closed.notify_one();
        });

        Ok(Self {
            child,
            stdin,
            inbound,
            stderr,
            stderr_closed,
            live_pid,
            pid,
        })
    }

    /// Wait for agy's `init` frame and return its conversation id.
    ///
    /// # Errors
    ///
    /// [`SpawnError::NoInit`] on timeout, on an early exit, or when agy reports
    /// an init without a conversation id. The error carries the redacted stderr
    /// tail.
    pub async fn wait_init(&mut self, timeout: Duration) -> Result<String, SpawnError> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let next = tokio::time::timeout_at(deadline, self.inbound.recv()).await;
            match next {
                Ok(Some(Inbound::Init {
                    conversation_id: Some(id),
                })) => return Ok(id),
                Ok(Some(Inbound::Init {
                    conversation_id: None,
                })) => {
                    return Err(self.no_init("agy init carried no conversation_id"));
                }
                Ok(Some(_)) => {}
                Ok(None) => return Err(self.no_init("agy exited before reporting init")),
                Err(_) => return Err(self.no_init("timed out waiting for agy init")),
            }
        }
    }

    /// Write one user event (agy's only accepted stdin shape) and flush.
    ///
    /// # Errors
    ///
    /// The underlying write error, or `Other` when agy's stdin is already gone.
    pub async fn send_user(&mut self, text: &str) -> std::io::Result<()> {
        let Some(stdin) = self.stdin.as_mut() else {
            return Err(std::io::Error::other("agy stdin is already closed"));
        };
        stdin.write_all(user_event(text).as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await
    }

    /// Next parsed stdout frame; `None` means stdout closed (agy exited).
    pub async fn recv(&mut self) -> Option<Inbound> {
        self.inbound.recv().await
    }

    /// Discard everything already queued — a `result` left over from a
    /// previous/killed turn must never be attributed to the next one.
    pub fn drain_stale(&mut self) {
        while self.inbound.try_recv().is_ok() {}
    }

    /// Kill (SIGKILL) and reap agy.
    pub async fn kill(&mut self) {
        // Clear first so a concurrent `session/cancel` cannot signal a pid
        // that is already dying (and might be reused).
        self.live_pid.store(0, Ordering::SeqCst);
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }

    /// Whether agy is still running (reaps an exited child).
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// True once stderr carried a `… not found` line (agy's unknown
    /// `--conversation` warning).
    pub fn saw_not_found_warning(&self) -> bool {
        self.stderr.lock().is_ok_and(|ring| ring.not_found)
    }

    /// Wait (bounded) until the stderr reader has drained to EOF.
    ///
    /// Only used on the exit path: agy's last stderr lines and its stdout EOF
    /// are produced concurrently, so reading the tail immediately can miss the
    /// very message that explains the exit.
    pub async fn stderr_settled(&self, wait: Duration) {
        let _ = tokio::time::timeout(wait, self.stderr_closed.notified()).await;
    }

    /// The bounded, redacted tail of agy's stderr.
    pub fn stderr_tail(&self) -> String {
        self.stderr
            .lock()
            .map(|ring| redact(&ring.tail()))
            .unwrap_or_default()
    }

    /// The OS pid of this agy process.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    fn no_init(&self, detail: &str) -> SpawnError {
        SpawnError::NoInit {
            detail: detail.to_string(),
            stderr_tail: self.stderr_tail(),
        }
    }
}

/// Send a signal to `pid` without `unsafe` (via `kill(1)`).
///
/// # Errors
///
/// When `kill` cannot be spawned, or exits non-zero (unknown pid, no
/// permission).
pub fn signal_pid(pid: u32, signal: Signal) -> std::io::Result<()> {
    let flag = match signal {
        Signal::Int => "-INT",
        Signal::Kill => "-KILL",
    };
    let output = std::process::Command::new("kill")
        .arg(flag)
        .arg(pid.to_string())
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "kill {flag} {pid} failed: {}",
            output.status
        )))
    }
}

/// Redact secret-looking material from a stderr tail before it reaches a chat
/// error message: any run of >= 24 chars made only of `[A-Za-z0-9_-./=+]`,
/// even inside a word (surrounding delimiters such as quotes or `?` are kept),
/// plus the word after `Bearer` (case-insensitive).
#[must_use]
pub fn redact(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut after_bearer = false;
    for word in text.split_whitespace() {
        if after_bearer {
            out.push("[redacted]".to_string());
            after_bearer = false;
            continue;
        }
        if word.eq_ignore_ascii_case("Bearer") {
            out.push(word.to_string());
            after_bearer = true;
            continue;
        }
        out.push(redact_runs(word));
    }
    out.join(" ")
}

fn is_secret_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '=' | '+')
}

/// Replace every maximal run of secret-charset chars of length >= 24 with
/// `[redacted]`, emitting all other characters verbatim.
fn redact_runs(word: &str) -> String {
    let mut out = String::with_capacity(word.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.len() >= 24 {
            out.push_str("[redacted]");
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for c in word.chars() {
        if is_secret_char(c) {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out
}

#[derive(Debug, Default)]
struct StderrRing {
    lines: VecDeque<String>,
    bytes: usize,
    not_found: bool,
}

impl StderrRing {
    fn push(&mut self, line: String) {
        if line.contains("not found") {
            self.not_found = true;
        }
        self.bytes += line.len();
        self.lines.push_back(line);
        while self.lines.len() > STDERR_MAX_LINES || self.bytes > STDERR_MAX_BYTES {
            let Some(front) = self.lines.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(front.len());
        }
    }

    fn tail(&self) -> String {
        self.lines
            .iter()
            .cloned()
            .collect::<Vec<String>>()
            .join("\n")
    }
}

/// Read one line, decoding lossily so a non-UTF-8 byte never ends the reader
/// (`lines()` would return `InvalidData` and stop). `None` only on EOF or a
/// real I/O error.
async fn next_lossy_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
) -> Option<String> {
    buf.clear();
    match reader.read_until(b'\n', buf).await {
        Ok(0) | Err(_) => None,
        Ok(_) => {
            if buf.last() == Some(&b'\n') {
                buf.pop();
                if buf.last() == Some(&b'\r') {
                    buf.pop();
                }
            }
            Some(String::from_utf8_lossy(buf).into_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn next_lossy_line_survives_non_utf8() {
        let mut reader = BufReader::new(&b"a\n\xff\xfe x\n{\"event\":\"init\"}\r\nlast"[..]);
        let mut buf = Vec::new();
        assert_eq!(
            next_lossy_line(&mut reader, &mut buf).await.as_deref(),
            Some("a")
        );
        assert_eq!(
            next_lossy_line(&mut reader, &mut buf).await.as_deref(),
            Some("\u{FFFD}\u{FFFD} x")
        );
        assert_eq!(
            next_lossy_line(&mut reader, &mut buf).await.as_deref(),
            Some("{\"event\":\"init\"}")
        );
        assert_eq!(
            next_lossy_line(&mut reader, &mut buf).await.as_deref(),
            Some("last")
        );
        assert_eq!(next_lossy_line(&mut reader, &mut buf).await, None);
    }

    use std::path::Path;
    use std::sync::Mutex as StdMutex;

    /// The fake agy reads its configuration from process-wide env vars, so
    /// these tests must not run concurrently with each other.
    static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    fn fake_agy() -> String {
        format!("{}/tests/fake_agy.py", env!("CARGO_MANIFEST_DIR"))
    }

    struct EnvGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
        keys: Vec<&'static str>,
    }

    impl EnvGuard {
        fn new(dir: &Path) -> Self {
            let lock = ENV_LOCK
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let keys = vec![
                "FAKE_AGY_ARGV_LOG",
                "FAKE_AGY_PID_FILE",
                "FAKE_AGY_SCENARIO",
                "FAKE_AGY_USER_LOG",
                "FAKE_AGY_KNOWN",
            ];
            for key in &keys {
                std::env::remove_var(key);
            }
            std::env::set_var("FAKE_AGY_ARGV_LOG", dir.join("argv.log"));
            std::env::set_var("FAKE_AGY_PID_FILE", dir.join("agy.pid"));
            Self { _lock: lock, keys }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for key in &self.keys {
                std::env::remove_var(key);
            }
        }
    }

    fn opts(dir: &Path) -> SpawnOpts {
        SpawnOpts {
            agy_bin: fake_agy(),
            cwd: dir.to_path_buf(),
            conversation: None,
            model: None,
        }
    }

    #[tokio::test]
    async fn spawn_and_wait_init_returns_id() {
        let dir = tempfile::tempdir().unwrap();
        let _env = EnvGuard::new(dir.path());
        let live_pid = Arc::new(AtomicU32::new(0));
        let mut proc =
            AgyProcess::spawn(&opts(dir.path()), Arc::clone(&live_pid)).expect("fake agy spawns");
        assert_ne!(live_pid.load(Ordering::SeqCst), 0);
        let id = proc.wait_init(Duration::from_secs(10)).await.expect("init");
        assert_eq!(id, "conv-new-0001");
        assert_eq!(proc.pid(), live_pid.load(Ordering::SeqCst));
        proc.kill().await;
    }

    #[tokio::test]
    async fn spawn_missing_binary_error_names_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut opts = opts(dir.path());
        opts.agy_bin = "/nonexistent/agy-binary-for-test".to_string();
        let error = AgyProcess::spawn(&opts, Arc::new(AtomicU32::new(0)))
            .expect_err("a missing binary must fail");
        let message = error.to_string();
        assert!(
            message.contains("/nonexistent/agy-binary-for-test"),
            "error must name the binary: {message}"
        );
    }

    #[tokio::test]
    async fn kill_reaps() {
        let dir = tempfile::tempdir().unwrap();
        let _env = EnvGuard::new(dir.path());
        let live_pid = Arc::new(AtomicU32::new(0));
        let mut proc =
            AgyProcess::spawn(&opts(dir.path()), Arc::clone(&live_pid)).expect("fake agy spawns");
        proc.wait_init(Duration::from_secs(10)).await.expect("init");
        assert!(proc.is_alive());
        proc.kill().await;
        assert!(!proc.is_alive(), "kill must reap the child");
        assert_eq!(live_pid.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn stderr_tail_redacts_long_tokens() {
        let token = "abcdefghij0123456789ABCDEFGHIJ0123456789";
        assert_eq!(token.len(), 40);
        let redacted = redact(&format!("fatal: signed out {token}"));
        assert_eq!(redacted, "fatal: signed out [redacted]");
        assert!(!redacted.contains(token));

        assert_eq!(
            redact("Authorization: Bearer sk-live-abc"),
            "Authorization: Bearer [redacted]"
        );
        assert_eq!(redact("short token: abc"), "short token: abc");

        let json = redact(r#"{"access_token":"ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz"}"#);
        assert!(!json.contains("ya29.a0AfH6SMB"));
        assert!(json.contains(r#""access_token":"[redacted]""#));

        let url = redact("GET https://x.io/v1?key=AIzaSyA1234567890abcdefghijklmnopq");
        assert!(!url.contains("AIzaSyA1234567890"));
        assert!(url.starts_with("GET https:"));

        assert_eq!(
            redact("authorization: bearer sk-x"),
            "authorization: bearer [redacted]"
        );

        let mut ring = StderrRing::default();
        ring.push(format!("warning: conversation \"x\" not found {token}"));
        assert!(ring.not_found);
        let tail = redact(&ring.tail());
        assert!(tail.contains("not found"));
        assert!(!tail.contains(token));
    }

    #[tokio::test]
    async fn spawn_uses_requested_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let session_cwd = dir.path().join("session-cwd");
        std::fs::create_dir_all(&session_cwd).unwrap();
        let _env = EnvGuard::new(dir.path());
        let mut proc = AgyProcess::spawn(&opts(&session_cwd), Arc::new(AtomicU32::new(0)))
            .expect("fake agy spawns");
        proc.wait_init(Duration::from_secs(10)).await.expect("init");
        proc.kill().await;

        let log = std::fs::read_to_string(dir.path().join("argv.log")).expect("argv log");
        let entry: serde_json::Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
        let reported = Path::new(entry["cwd"].as_str().unwrap());
        assert_eq!(
            reported.canonicalize().unwrap(),
            session_cwd.canonicalize().unwrap()
        );
        let argv: Vec<&str> = entry["argv"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(argv.contains(&"--dangerously-skip-permissions"));
        assert!(argv.contains(&"--print="));
        assert!(!argv.contains(&"--conversation"));
    }
}
