//! Test-only tmux isolation (`#[doc(hidden)]`): tests must never touch the
//! developer's DEFAULT tmux server. Everything here addresses a private `-L`
//! socket and only ever kills THAT socket's server.

use crate::tmux::Tmux;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;

static NEXT: AtomicUsize = AtomicUsize::new(0);
static SHARED: OnceLock<String> = OnceLock::new();

/// Socket-name prefix for test servers (distinct from the older `vst-test-*`).
pub const SOCKET_PREFIX: &str = "vst-rtest-";

/// Kills its own private socket's tmux server on drop.
pub struct TmuxGuard(String);

impl TmuxGuard {
    pub fn new() -> Self {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        Self(format!("{SOCKET_PREFIX}{}-g{n}", std::process::id()))
    }
    pub fn socket(&self) -> &str {
        &self.0
    }
    pub fn tmux(&self) -> Tmux {
        Tmux::with_socket(self.0.clone())
    }
}

impl Default for TmuxGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TmuxGuard {
    fn drop(&mut self) {
        Tmux::with_socket(self.0.clone()).kill_server();
    }
}

extern "C" fn kill_shared() {
    if let Some(sock) = SHARED.get() {
        Tmux::with_socket(sock.clone()).kill_server();
    }
}

/// A `Tmux` on this test process's private socket. The server is killed at
/// process exit (`atexit`), so a test binary leaves nothing behind even when
/// individual tests fail or panic. Never the default server.
pub fn isolated_tmux() -> Tmux {
    let sock = SHARED.get_or_init(|| {
        // SAFETY: registering a plain `extern "C" fn()` with libc's atexit.
        #[allow(unsafe_code)]
        unsafe {
            libc::atexit(kill_shared);
        }
        format!("{SOCKET_PREFIX}{}-shared", std::process::id())
    });
    Tmux::with_socket(sock.clone())
}

/// Make every later pane of `tmux`'s server a NON-login `/bin/sh` whose `PATH`
/// starts with `path_prefix`, so a test's stub binaries are found whatever the
/// host's login-shell profile does to `PATH` (Debian's `/etc/profile`
/// overwrites it). `default-command` is server-global: hold a lock for the
/// whole test. The server is started with a keep-alive session when it is not
/// running yet; it dies with the others at process exit (`kill_shared`).
pub fn use_plain_shell(tmux: &Tmux, path_prefix: &std::path::Path) {
    const KEEPALIVE: &str = "vst-test-keepalive";
    if !tmux.has_session(KEEPALIVE) {
        let _ = tmux.new_session(&crate::tmux::NewSessionOptions {
            name: KEEPALIVE.to_string(),
            cwd: None,
            env: std::collections::HashMap::new(),
            command: Some(vec!["sleep".to_string(), "3600".to_string()]),
            remain_on_exit: false,
        });
    }
    let value = format!(
        "PATH={}:\"$PATH\" exec /bin/sh",
        crate::shell::sq(&path_prefix.to_string_lossy())
    );
    tmux.run(&["set-option", "-g", "default-command", &value])
        .expect("set default-command on the isolated tmux server");
}
