//! `TmuxOutputStream` — manages a tmux session attachment via a real PTY
//! (`tmux attach-session`).
//!
//! Ports `daemon/src/ws/streams/tmuxOutput.ts`. tmux drives the terminal via
//! cursor escape sequences flowing over the PTY byte stream — same model as a
//! user attaching from a real terminal — so xterm receives a faithful, in-sync
//! byte stream and never has to re-render a static snapshot.
//!
//! This is a DIFFERENT PTY code path from `vst_proc::PtyHandle` (which is
//! direct-PTY, no tmux). It uses `vst_proc::Tmux`-style command wrappers
//! (invoked directly with a socket) for the pre-flight checks + option set +
//! window resize, and portable-pty to spawn `tmux attach-session`.
//!
//! The attach/detach semantics here are the subject of Gotcha #6 / AGENTS.md §
//! Terminal + § WebSocket: killing the PTY (SIGHUP) detaches this client
//! without touching the underlying tmux session — the session keeps running for
//! the next attach.
//!
//! `detach()` must actually kill the `tmux attach-session` child (mirroring
//! Node's `pty.kill()`), not just drop Rust-side state: the PTY master here is
//! obtained via `try_clone_reader()` (a `dup`), so dropping `master` does NOT
//! close the underlying fd or send the child EOF/SIGHUP — the reader thread's
//! own clone keeps it open. Without an explicit kill, the `attach-session`
//! child (and thus its tmux *client*, not the session) lives forever, and
//! every close→open remount (worktree switch, layout toggle) leaves one more
//! phantom client permanently attached, mirroring the shell's keystroke echo
//! to every leaked client — this is what turns "s" into "ss", "sss", etc.
//! Killing the client here is exactly tmux's normal detach (`Ctrl-b d`
//! semantics): the session and its pane process are never touched.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::connection::SessionStream;
use crate::Error;

const CHUNK_CAP: usize = 1024;
const EVENT_CAP: usize = 64;

struct Inner {
    tmux_name: String,
    socket: Option<String>,
    closed: AtomicBool,
    chunk_tx: tokio::sync::broadcast::Sender<String>,
    close_tx: tokio::sync::broadcast::Sender<()>,
    opened_tx: tokio::sync::broadcast::Sender<()>,
    error_tx: tokio::sync::broadcast::Sender<String>,
    master: std::sync::Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>,
    /// Split out from the `Child` so it can be signalled independently of the
    /// reap thread blocked in `.wait()`. `None` until `attach()` has spawned
    /// the child; `detach()` uses this to actually terminate the
    /// `tmux attach-session` client (SIGHUP on unix — see module doc).
    killer: std::sync::Mutex<Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
}

/// Outcome of a `tmux has-session` probe.
enum SessionProbe {
    /// The session is there.
    Exists,
    /// tmux answered, and its answer was "no such session".
    Missing,
    /// tmux could not be asked (spawn failed, no server, socket error). Says
    /// nothing about whether the session is alive.
    Unreachable(String),
}

/// A tmux `attach-session` PTY stream. Single-subscriber per instance (one per
/// connection).
pub struct TmuxOutputStream {
    inner: Arc<Inner>,
}

impl TmuxOutputStream {
    pub fn new(tmux_name: String, socket: Option<String>) -> Self {
        let (chunk_tx, _) = tokio::sync::broadcast::channel(CHUNK_CAP);
        let (close_tx, _) = tokio::sync::broadcast::channel(EVENT_CAP);
        let (opened_tx, _) = tokio::sync::broadcast::channel(EVENT_CAP);
        let (error_tx, _) = tokio::sync::broadcast::channel(EVENT_CAP);
        TmuxOutputStream {
            inner: Arc::new(Inner {
                tmux_name,
                socket,
                closed: AtomicBool::new(false),
                chunk_tx,
                close_tx,
                opened_tx,
                error_tx,
                master: std::sync::Mutex::new(None),
                killer: std::sync::Mutex::new(None),
            }),
        }
    }

    // ── Async variants used by `attach()` ────────────────────────────────────
    // These use `tokio::process::Command` so they yield back to the runtime
    // instead of blocking a tokio worker thread while waiting for the tmux
    // subprocess to reply.

    async fn run_async(&self, args: &[&str]) -> Result<(), Error> {
        let mut cmd = tokio::process::Command::new("tmux");
        if let Some(sock) = &self.inner.socket {
            cmd.arg("-L").arg(sock);
        }
        cmd.args(args);
        let out = cmd
            .output()
            .await
            .map_err(|e| Error::Stream(format!("io: {e}")))?;
        if !out.status.success() {
            return Err(Error::Stream(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        Ok(())
    }

    /// Run `has-session` and report which of the three distinguishable outcomes
    /// it was.
    ///
    /// A plain `bool` collapsed "this session does not exist" together with
    /// "tmux could not be reached at all" (spawn failure, no server, a broken
    /// socket). Those must NOT be reported the same way: the first is terminal
    /// and classified `gone`, which the web UI treats as an exit (Resume
    /// banner, and a resume can re-spawn a session that is actually still
    /// alive), while the second is a transient failure to talk to tmux.
    async fn probe_session(&self) -> SessionProbe {
        let mut cmd = tokio::process::Command::new("tmux");
        if let Some(sock) = &self.inner.socket {
            cmd.arg("-L").arg(sock);
        }
        cmd.args(["has-session", "-t", &self.inner.tmux_name]);
        match cmd.output().await {
            Err(e) => SessionProbe::Unreachable(format!("io: {e}")),
            Ok(out) if out.status.success() => SessionProbe::Exists,
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                // Only tmux's own "this session is not here" wording means
                // gone. Anything else (e.g. "no server running on ...", a
                // permission error) is a connectivity problem, not proof that
                // the session died.
                let lowered = stderr.to_ascii_lowercase();
                if lowered.contains("can't find session")
                    || lowered.contains("cant find session")
                    || lowered.contains("session not found")
                    || lowered.contains("no such session")
                {
                    SessionProbe::Missing
                } else {
                    SessionProbe::Unreachable(stderr)
                }
            }
        }
    }

    // (`resize-window` on attach is chained into the single pre-flight
    // invocation in `attach()`; `resize()` uses the async helper below.)

    /// Apply `tmux resize-window` for a user-driven resize event.
    ///
    /// Uses `tokio::process` (not `std::process`) so waiting on the tmux
    /// subprocess parks the task instead of pinning a tokio worker thread —
    /// see [`SessionStream::resize`]. Awaited by the caller, so successive
    /// resizes apply in the order they were issued.
    async fn force_window_size(&self, cols: i64, rows: i64) {
        let _ = self
            .run_async(&[
                "resize-window",
                "-t",
                &self.inner.tmux_name,
                "-x",
                &cols.to_string(),
                "-y",
                &rows.to_string(),
            ])
            .await;
    }
}

#[async_trait::async_trait]
impl SessionStream for TmuxOutputStream {
    async fn attach(&self, cols: i64, rows: i64, _subscriber_id: &str) -> Result<(), Error> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Pre-flight, in ONE tmux invocation: confirm the session exists, hide
        // the status bar, enable mouse mode, and force the window size. These
        // used to be four separate `tmux` processes, i.e. four sequential
        // round-trips to the single-threaded tmux server — which during a
        // worktree switch is simultaneously repainting every other pane being
        // attached, so each round-trip is pure added latency before the client's
        // `session:opened` (and its spawning overlay) can clear. tmux's own
        // command separator is a literal `;` argument (no shell involved here —
        // these are argv elements).
        //
        // `has-session` stays as the first command in the chain so a
        // missing/dead session still fails fast: without it a bare
        // `tmux attach-session` prints "can't find session" INTO the pty before
        // exiting non-zero, which lands as garbage in the user's viewport.
        //
        // Order matters: tmux ABORTS a command list at the first failing
        // command, so `resize-window` — the one whose effect the user actually
        // sees — runs before the two best-effort `set-option`s, which are the
        // ones that could plausibly be rejected (older tmux, unknown option)
        // and take the rest of the chain down with them.
        let name = self.inner.tmux_name.clone();
        let cols_s = cols.to_string();
        let rows_s = rows.to_string();
        let preflight: Vec<&str> = vec![
            "has-session",
            "-t",
            &name,
            ";",
            "resize-window",
            "-t",
            &name,
            "-x",
            &cols_s,
            "-y",
            &rows_s,
            ";",
            "set-option",
            "-t",
            &name,
            "status",
            "off",
            ";",
            "set-option",
            "-t",
            &name,
            "mouse",
            "on",
        ];
        if self.run_async(&preflight).await.is_err() {
            // The chain as a whole is best-effort: the option sets and
            // `resize-window` were always allowed to fail, and one failing
            // command fails the whole invocation. So re-ask specifically about
            // the session before giving up — one extra round-trip on the error
            // path only, never on the happy path.
            match self.probe_session().await {
                // Only an option/resize rejection: attach anyway, exactly as
                // the four independent best-effort calls used to.
                SessionProbe::Exists => {}
                SessionProbe::Missing => {
                    self.inner.closed.store(true, Ordering::SeqCst);
                    // Terminal, not transient: there is nothing to attach to
                    // and no `opened` will ever follow, so it must NOT be
                    // reported via `error_tx` (which `session_open` classifies
                    // as `transient`, leaving the client waiting on
                    // `session:opened` forever). `SessionNotFound` is what
                    // `session_open` maps to the `gone` reason it already sends
                    // for a not-running direct-pty session.
                    return Err(Error::SessionNotFound(format!(
                        "Session '{}' not running",
                        self.inner.tmux_name
                    )));
                }
                SessionProbe::Unreachable(detail) => {
                    self.inner.closed.store(true, Ordering::SeqCst);
                    // We could not reach tmux, which is NOT evidence the
                    // session died — `Error::Stream` keeps this `transient` so
                    // the client does not flip a possibly-live session to
                    // "exited" (and offer a Resume that would re-spawn it).
                    return Err(Error::Stream(format!(
                        "Could not reach tmux while attaching to '{}': {detail}",
                        self.inner.tmux_name
                    )));
                }
            }
        }

        // Spawn `tmux attach-session` in a PTY. `portable_pty` has no async
        // API so we move the blocking openpty + spawn_command + try_clone_reader
        // calls into spawn_blocking to keep the worker free.
        let tmux_name = self.inner.tmux_name.clone();
        let socket = self.inner.socket.clone();
        let (master, reader, mut child, killer) =
            tokio::task::spawn_blocking(move || -> Result<_, Error> {
                let pty_system = portable_pty::native_pty_system();
                let pair = pty_system
                    .openpty(portable_pty::PtySize {
                        rows: rows as u16,
                        cols: cols as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|e| Error::Stream(format!("openpty: {e}")))?;

                let mut cmd = portable_pty::CommandBuilder::new("tmux");
                let mut argv: Vec<String> = vec![];
                if let Some(sock) = &socket {
                    argv.push("-L".to_string());
                    argv.push(sock.clone());
                }
                // -u: force this client into UTF-8 mode regardless of the
                // ambient locale. On tmux <= 3.3, a client attaching without
                // a UTF-8 LANG/LC_ALL/LC_CTYPE gets treated as non-UTF-8:
                // every non-ASCII byte tmux would otherwise send is rewritten
                // to a literal '_', and box-drawing characters become ACS
                // escapes instead of real glyphs — exactly the "icons render
                // as underscores/dashes" bug traced back to this. tmux >= 3.4
                // dropped the locale check and always assumes UTF-8, so `-u`
                // is a no-op there; harmless either way. This makes the
                // client's UTF-8 mode independent of whatever locale the
                // daemon process happens to have inherited (a bare/minimal
                // environment, e.g. a container with no locale generated,
                // would otherwise silently hit the broken path).
                argv.push("-u".to_string());
                argv.push("attach-session".to_string());
                // -d: force-detach any other client already attached to this
                // session. Our own close/detach path SIGHUPs the previous
                // client but deliberately doesn't wait for it to exit (see
                // `detach()` below), so a fast-enough close+open (worktree
                // switch, rapid remounts) can otherwise attach a second live
                // client before the first is gone — tmux would then mirror
                // output to both, doubling every echoed keystroke. `-d` makes
                // tmux itself enforce "at most one client" regardless of that
                // timing.
                argv.push("-d".to_string());
                argv.push("-t".to_string());
                argv.push(tmux_name);
                cmd.args(&argv);
                cmd.env("TERM", "xterm-256color");
                // Belt-and-braces alongside `-u`: some tmux-internal paths
                // (and the pane's own shell/CLI) consult the locale directly
                // rather than tmux's own UTF-8 flag. C.UTF-8 is a minimal
                // glibc locale present without needing `locale-gen`.
                cmd.env("LC_ALL", "C.UTF-8");

                let child = pair
                    .slave
                    .spawn_command(cmd)
                    .map_err(|e| Error::Stream(format!("spawn attach-session: {e}")))?;
                drop(pair.slave);

                // Split out before `child` moves into the reap thread — this
                // is what lets `detach()` signal the client independently of
                // the thread blocked in `child.wait()`.
                let killer = child.clone_killer();

                let reader = pair
                    .master
                    .try_clone_reader()
                    .map_err(|e| Error::Stream(format!("clone reader: {e}")))?;

                Ok((pair.master, reader, child, killer))
            })
            .await
            .map_err(|e| Error::Stream(format!("spawn_blocking: {e}")))??;

        *self.inner.master.lock().unwrap() = Some(master);
        *self.inner.killer.lock().unwrap() = Some(killer);
        let _ = self.inner.opened_tx.send(());

        let chunk_tx = self.inner.chunk_tx.clone();
        let close_tx = self.inner.close_tx.clone();

        // Reader thread: drain master output until EOF, forwarding chunks.
        // Uses a dedicated OS thread (not a tokio task) because the read is a
        // blocking PTY read that parks in the kernel until data arrives.
        //
        // `pending` carries any UTF-8 sequence left incomplete at the tail of
        // a 4096-byte read across to the next one, instead of lossily
        // decoding per-read. A `read()` on a PTY has no notion of character
        // boundaries, and tmux/agent TUIs are UTF-8-heavy (box-drawing,
        // spinners); a scroll-triggered full-screen repaint spans many read
        // boundaries, so decoding each read in isolation reliably shredded
        // some characters into `�` (U+FFFD) on scroll. node-pty's default
        // `StringDecoder`-backed 'utf8' encoding did this buffering for the
        // old Node daemon; this reproduces the same semantics.
        let mut reader = reader;
        // Cloned so the reader can check `closed` (set synchronously by
        // `detach()`, before the kill signal has necessarily taken effect)
        // and stop publishing immediately rather than racing the child's
        // actual exit — ports Node's `if (this.closed) return` guard in its
        // `onData` handler.
        let inner_for_reader = self.inner.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                if inner_for_reader.closed.load(Ordering::SeqCst) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if inner_for_reader.closed.load(Ordering::SeqCst) {
                            break;
                        }
                        pending.extend_from_slice(&buf[..n]);
                        loop {
                            match std::str::from_utf8(&pending) {
                                Ok(s) => {
                                    let _ = chunk_tx.send(s.to_owned());
                                    pending.clear();
                                    break;
                                }
                                Err(e) => {
                                    let valid_up_to = e.valid_up_to();
                                    match e.error_len() {
                                        // Tail sequence is incomplete (not
                                        // invalid) — hold it back for the
                                        // next read.
                                        None => {
                                            if valid_up_to > 0 {
                                                let s = std::str::from_utf8(&pending[..valid_up_to])
                                                    .expect("validated prefix")
                                                    .to_owned();
                                                let _ = chunk_tx.send(s);
                                            }
                                            pending.drain(..valid_up_to);
                                            break;
                                        }
                                        // Genuinely invalid bytes (not a
                                        // boundary split) — emit the valid
                                        // prefix plus one replacement char,
                                        // skip past them, keep decoding the
                                        // rest of `pending`.
                                        Some(bad_len) => {
                                            let end = valid_up_to + bad_len;
                                            let mut s =
                                                std::str::from_utf8(&pending[..valid_up_to])
                                                    .expect("validated prefix")
                                                    .to_owned();
                                            s.push('\u{FFFD}');
                                            let _ = chunk_tx.send(s);
                                            pending.drain(..end);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            // Flush any bytes still pending (e.g. a trailing partial
            // sequence right at EOF) lossily rather than dropping them —
            // unless this reader was stopped by `detach()` rather than a
            // real EOF, in which case the bytes belong to a dead client and
            // must not be forwarded.
            if !pending.is_empty() && !inner_for_reader.closed.load(Ordering::SeqCst) {
                let _ = chunk_tx.send(String::from_utf8_lossy(&pending).into_owned());
            }
            // A clean EOF on `tmux attach-session` means the client detached —
            // the session itself is fine. Signal `close`.
            let _ = close_tx.send(());
        });

        // Reap thread so we don't leak a zombie.
        std::thread::spawn(move || {
            let _ = child.wait();
        });

        Ok(())
    }

    /// Write raw bytes into the pty via `MasterPty::as_raw_fd()` directly —
    /// deliberately NOT via `MasterPty::take_writer()`.
    ///
    /// `take_writer()`'s own doc comment says it plainly: "Dropping the
    /// writer will send EOF to the slave end. It is invalid to take the
    /// writer more than once." Its `Drop` impl (portable-pty's
    /// `UnixMasterWriter`) unconditionally writes a synthetic `\n` + the
    /// terminal's EOF character (Ctrl-D) into the pty before closing its own
    /// duplicated fd. For the `tmux attach-session` child on the other end
    /// of this pty, that phantom EOF is indistinguishable from the user
    /// actually typing Ctrl-D — tmux passes it straight through as real
    /// input to the active pane's shell, which interprets EOF-at-an-empty-
    /// prompt as "exit", killing the pane and, since it's the session's only
    /// pane, the whole tmux SESSION (and the server, once it has zero
    /// sessions left).
    ///
    /// This was live-reproduced two different ways: (1) calling
    /// `take_writer()` fresh on every keystroke (the original bug) sent this
    /// phantom EOF after every single character, killing the session on the
    /// very first keystroke/tap; (2) even after fixing that by taking the
    /// writer once and holding it for the stream's lifetime, dropping that
    /// held writer exactly once — in `detach()`, i.e. on every WS
    /// disconnect/tab-switch/remount — still sent the same phantom EOF at
    /// that moment, killing the session on detach instead of on keystroke.
    /// Neither "take once per write" nor "take once per stream" avoids the
    /// footgun; only never taking a `Write` handle at all does. Writing
    /// through the master's own raw fd (borrowed, not a `try_clone()`'d
    /// duplicate — see `take_writer()`'s impl) has no such side effect on
    /// its own, and we never close or otherwise take ownership of it here:
    /// `master`'s own `Drop` (triggered when `detach()` clears the
    /// `Mutex<Option<..>>`) closes the real fd exactly once, same as before
    /// this change.
    fn write(&self, data: &str) {
        if self.inner.closed.load(Ordering::SeqCst) {
            return;
        }
        let fd = match self.inner.master.lock().unwrap().as_ref() {
            Some(master) => master.as_raw_fd(),
            None => None,
        };
        let Some(fd) = fd else { return };
        // `fd` is still owned by `master` (held in the mutex above; only
        // `detach()` clears it, under the same lock) — `write_borrowed_fd`
        // writes through it without taking ownership, so it is never closed
        // here. This crate `#![forbid(unsafe_code)]`; the one documented
        // `unsafe` FFI boundary this needs lives in `vst-proc` instead — see
        // its module doc comment for why this must not go through
        // `MasterPty::take_writer()`.
        vst_proc::write_borrowed_fd(fd, data.as_bytes());
    }

    /// True once `attach()` has installed the PTY master, i.e. once `write()`
    /// has somewhere to write. False in the window between the stream entry
    /// being registered and the attach completing (and again after `detach()`).
    fn is_attached(&self) -> bool {
        self.inner.master.lock().unwrap().is_some()
    }

    async fn resize(&self, cols: i64, rows: i64, _subscriber_id: Option<&str>) {
        if self.inner.closed.load(Ordering::SeqCst) {
            return;
        }
        // Scoped so the `std::sync::Mutex` guard is dropped before the await
        // below — a std guard must never be held across an await point.
        {
            if let Some(master) = self.inner.master.lock().unwrap().as_mut() {
                let _ = master.resize(portable_pty::PtySize {
                    rows: rows as u16,
                    cols: cols as u16,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
        }
        self.force_window_size(cols, rows).await;
    }

    async fn detach(&self, _subscriber_id: &str) -> Result<(), Error> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.inner.closed.store(true, Ordering::SeqCst);
        // Actually terminate the `tmux attach-session` client — SIGHUP on
        // unix (see `ChildKiller::kill` in portable-pty), the same signal a
        // real terminal sends on hangup. This ONLY detaches this client from
        // the tmux session; the session and its pane process are untouched
        // and stay running for the next attach (identical to `Ctrl-b d`).
        // Fire-and-forget and non-blocking: this must not `.await` the
        // child's actual exit, since `detach()` runs inside
        // `WsConnection::with_session_lock` and blocking the lock on a
        // process-death round-trip is exactly the kind of stall the
        // tokio::process/spawn_blocking migration in `attach()` was meant to
        // eliminate. The existing reap thread (spawned in `attach()`) absorbs
        // the `wait()` once the signal lands.
        if let Some(killer) = self.inner.killer.lock().unwrap().as_mut() {
            let _ = killer.kill();
        }
        *self.inner.master.lock().unwrap() = None;
        let _ = self.inner.close_tx.send(());
        Ok(())
    }

    fn on_chunk(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.inner.chunk_tx.subscribe()
    }
    fn on_close(&self) -> tokio::sync::broadcast::Receiver<()> {
        self.inner.close_tx.subscribe()
    }
    fn on_opened(&self) -> tokio::sync::broadcast::Receiver<()> {
        self.inner.opened_tx.subscribe()
    }
    fn on_error(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.inner.error_tx.subscribe()
    }
}

impl std::fmt::Debug for TmuxOutputStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TmuxOutputStream")
            .field("tmux_name", &self.inner.tmux_name)
            .field("socket", &self.inner.socket)
            .field("closed", &self.inner.closed.load(Ordering::SeqCst))
            .finish()
    }
}
