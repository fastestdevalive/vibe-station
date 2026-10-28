//! A hung tmux is killed at the per-call timeout instead of blocking forever.
//! Own test binary: it points PATH at a fake `tmux` for the whole process.

use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};

use vst_proc::tmux::Tmux;

#[test]
fn hung_tmux_calls_fail_at_the_timeout() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("tmux");
    std::fs::write(&script, "#!/bin/sh\nexec sleep 30\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let old = std::env::var_os("PATH").unwrap_or_default();
    let mut path = std::ffi::OsString::from(dir.path());
    path.push(":");
    path.push(&old);
    std::env::set_var("PATH", &path);

    let tmux = Tmux::with_socket("hang-test").with_call_timeout(Duration::from_millis(300));
    let t = Instant::now();
    let err = tmux.send_enter("=x:").unwrap_err();
    assert!(err.stderr().contains("did not finish"), "{}", err.stderr());
    assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());

    // capture_screen and the stdin path are bounded too.
    let t = Instant::now();
    assert!(tmux.capture_screen("=x:").is_err());
    assert!(tmux.paste_buffer_with("=x:", "b", "hello", false).is_err());
    assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    std::env::set_var("PATH", old);
}
