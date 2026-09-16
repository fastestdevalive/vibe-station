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

use std::process::Command;
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
            }),
        }
    }

    fn tmux_command(&self) -> Command {
        let mut cmd = Command::new("tmux");
        if let Some(sock) = &self.inner.socket {
            cmd.arg("-L").arg(sock);
        }
        cmd
    }

    fn run(&self, args: &[&str]) -> Result<(), Error> {
        let out = self
            .tmux_command()
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

    fn has_session(&self) -> bool {
        self.run(&["has-session", "-t", &self.inner.tmux_name])
            .is_ok()
    }

    fn force_window_size(&self, cols: i64, rows: i64) {
        let _ = self.run(&[
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

        // Pre-flight: confirm the tmux session exists. Without this check, a
        // missing/dead session causes `tmux attach-session` to print "can't
        // find session" into the pty before exiting non-zero — which lands as
        // garbage in the user's viewport.
        if !self.has_session() {
            self.inner.closed.store(true, Ordering::SeqCst);
            let _ = self
                .inner
                .error_tx
                .send(format!("Session '{}' not running", self.inner.tmux_name));
            return Ok(());
        }

        // Best-effort: hide the status bar + enable mouse mode.
        let _ = self.run(&["set-option", "-t", &self.inner.tmux_name, "status", "off"]);
        let _ = self.run(&["set-option", "-t", &self.inner.tmux_name, "mouse", "on"]);
        self.force_window_size(cols, rows);

        // Spawn `tmux attach-session` in a PTY.
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
        if let Some(sock) = &self.inner.socket {
            argv.push("-L".to_string());
            argv.push(sock.clone());
        }
        argv.push("attach-session".to_string());
        argv.push("-t".to_string());
        argv.push(self.inner.tmux_name.clone());
        cmd.args(&argv);
        cmd.env("TERM", "xterm-256color");

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| Error::Stream(format!("spawn attach-session: {e}")))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| Error::Stream(format!("clone reader: {e}")))?;

        *self.inner.master.lock().unwrap() = Some(pair.master);
        let _ = self.inner.opened_tx.send(());

        let chunk_tx = self.inner.chunk_tx.clone();
        let close_tx = self.inner.close_tx.clone();

        // Reader thread: drain master output until EOF, forwarding chunks.
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let _ = chunk_tx.send(chunk);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
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
        self.force_window_size(cols, rows);
    }

    async fn detach(&self, _subscriber_id: &str) -> Result<(), Error> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.inner.closed.store(true, Ordering::SeqCst);
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
