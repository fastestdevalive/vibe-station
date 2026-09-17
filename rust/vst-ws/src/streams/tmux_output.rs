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

    async fn has_session_async(&self) -> bool {
        self.run_async(&["has-session", "-t", &self.inner.tmux_name])
            .await
            .is_ok()
    }

    async fn force_window_size_async(&self, cols: i64, rows: i64) {
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

    // ── Sync variants kept for `resize()` (called on user resize events) ─────

    fn run_sync(&self, args: &[&str]) -> Result<(), Error> {
        let mut cmd = std::process::Command::new("tmux");
        if let Some(sock) = &self.inner.socket {
            cmd.arg("-L").arg(sock);
        }
        let out = cmd
            .args(args)
            .output()
            .map_err(|e| Error::Stream(format!("io: {e}")))?;
        if !out.status.success() {
            return Err(Error::Stream(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        Ok(())
    }

    fn force_window_size_sync(&self, cols: i64, rows: i64) {
        let _ = self.run_sync(&[
            "resize-window",
            "-t",
            &self.inner.tmux_name,
            "-x",
            &cols.to_string(),
            "-y",
            &rows.to_string(),
        ]);
    }
}

#[async_trait::async_trait]
impl SessionStream for TmuxOutputStream {
    async fn attach(&self, cols: i64, rows: i64, _subscriber_id: &str) -> Result<(), Error> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Pre-flight: confirm the tmux session exists. Uses tokio::process so
        // it yields instead of blocking a worker thread.
        if !self.has_session_async().await {
            self.inner.closed.store(true, Ordering::SeqCst);
            let _ = self
                .inner
                .error_tx
                .send(format!("Session '{}' not running", self.inner.tmux_name));
            return Ok(());
        }

        // Best-effort: hide the status bar + enable mouse mode. Non-fatal.
        let _ = self
            .run_async(&["set-option", "-t", &self.inner.tmux_name, "status", "off"])
            .await;
        let _ = self
            .run_async(&["set-option", "-t", &self.inner.tmux_name, "mouse", "on"])
            .await;
        self.force_window_size_async(cols, rows).await;

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
                argv.push("attach-session".to_string());
                argv.push("-t".to_string());
                argv.push(tmux_name);
                cmd.args(&argv);
                cmd.env("TERM", "xterm-256color");

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

    fn resize(&self, cols: i64, rows: i64, _subscriber_id: Option<&str>) {
        if self.inner.closed.load(Ordering::SeqCst) {
            return;
        }
        if let Some(master) = self.inner.master.lock().unwrap().as_mut() {
            let _ = master.resize(portable_pty::PtySize {
                rows: rows as u16,
                cols: cols as u16,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
        self.force_window_size_sync(cols, rows);
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
