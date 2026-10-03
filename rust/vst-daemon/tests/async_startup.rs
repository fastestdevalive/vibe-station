//! The listener must bind before the post-bind boot work (cloudflared orphan
//! sweep, tailscale check) finishes, and shutdown must not wait on it.
//!
//! A fake `pgrep` on `PATH` sleeps for several seconds — the real sweep forks
//! `pgrep -x cloudflared`, so this stands in for a slow sweep. The daemon runs
//! with an isolated `HOME` and a loopback bind (the default); `/health` is
//! unauthenticated so auth state doesn't matter.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const FAKE_PGREP_SLEEP_SECS: u64 = 6;

fn health_ok(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
    if s.write_all(b"GET /health HTTP/1.0\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = String::new();
    let _ = s.read_to_string(&mut buf);
    buf.starts_with("HTTP/1.0 200") || buf.starts_with("HTTP/1.1 200")
}

#[test]
fn binds_before_slow_background_boot_and_shutdown_does_not_wait() {
    let home = tempfile::tempdir().unwrap();
    let bin_dir = home.path().join("fakebin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let marker = home.path().join("pgrep-started");
    let pgrep = bin_dir.join("pgrep");
    std::fs::write(
        &pgrep,
        format!(
            "#!/bin/sh\ntouch '{}'\nsleep {FAKE_PGREP_SLEEP_SECS}\nexit 1\n",
            marker.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&pgrep, std::fs::Permissions::from_mode(0o755)).unwrap();

    // Fake `tailscale` too: the post-bind drift check must neither reach a
    // real tailscaled nor hold up shutdown while it hangs.
    let tailscale = bin_dir.join("tailscale");
    std::fs::write(
        &tailscale,
        format!("#!/bin/sh\nsleep {FAKE_PGREP_SLEEP_SECS}\n"),
    )
    .unwrap();
    std::fs::set_permissions(&tailscale, std::fs::Permissions::from_mode(0o755)).unwrap();

    // OS-assigned ephemeral port (released right before the daemon binds it).
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let path = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_vst-daemon"))
        .env("HOME", home.path())
        .env("TMUX_TMPDIR", home.path())
        .env("VST_PORT", port.to_string())
        .env("PATH", path)
        .env_remove("VST_NO_AUTH")
        .env_remove("TMUX")
        .env_remove("VST_TUNNEL_PORT")
        .env_remove("VST_CLOUDFLARED_BIN")
        .env_remove("VST_DIST_PATH")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn vst-daemon");

    let start = Instant::now();
    while !health_ok(port) {
        assert!(
            start.elapsed() < Duration::from_secs(FAKE_PGREP_SLEEP_SECS - 1),
            "/health not up before the slow sweep would have finished"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // Prove the background sweep really was in flight when we got the 200.
    let wait_marker = Instant::now();
    while !marker.exists() && wait_marker.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(marker.exists(), "fake pgrep never ran: sweep did not start");

    // Shutdown aborts the in-flight sweep rather than waiting out pgrep.
    let t = Instant::now();
    Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    let deadline = Duration::from_secs(FAKE_PGREP_SLEEP_SECS - 2);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if t.elapsed() > deadline {
            let _ = child.kill();
            panic!("daemon did not exit within {deadline:?} of SIGTERM");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
