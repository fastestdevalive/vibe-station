//! 5.T15: a real tmux pane (isolated socket) running `cat` as the "agent":
//! the text lands exactly once with a trailing Enter, control chars stripped.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use vst_proc::tmux::{NewSessionOptions, Tmux};
use vst_review::{
    BoxFuture, NotifyScheduled, TargetResolver, TerminalDeliveryHandle, TerminalTarget,
};
use vst_store::StoreHandle;
use vst_types::terminal_delivery::{TerminalDeliveryCaps, TerminalReadiness};

struct CatResolver(String);

impl TargetResolver for CatResolver {
    fn resolve(&self, _id: &str) -> BoxFuture<'_, Option<TerminalTarget>> {
        let t = TerminalTarget {
            tmux_name: self.0.clone(),
            channel_is_tmux: true,
            channel_is_json: false,
            gone: false,
            exited: false,
            caps: Some(TerminalDeliveryCaps {
                settle_ms: 50,
                multiline_ok: true,
                raw_lf: false,
            }),
            probe: Arc::new(|_| TerminalReadiness::Ready),
        };
        Box::pin(async move { Some(t) })
    }
}

/// Ends the isolated tmux server (by its own socket name only) even when the
/// test panics.
struct KillServer(Tmux);

impl Drop for KillServer {
    fn drop(&mut self) {
        self.0.kill_server();
    }
}

fn unique_socket() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!(
        "vst-review-test-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn text_lands_once_with_enter_and_control_chars_stripped() {
    if std::process::Command::new("tmux")
        .arg("-V")
        .output()
        .is_err()
    {
        eprintln!("tmux not installed; skipping");
        return;
    }
    let sock = unique_socket();
    let tmux = Tmux::with_socket(&sock);
    let _server = KillServer(tmux.clone());
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("received.txt");
    let script = format!("cat > {}", out.display());
    tmux.new_session(&NewSessionOptions {
        name: "agent".into(),
        command: Some(vec!["sh".into(), "-c".into(), script]),
        ..Default::default()
    })
    .expect("new session");

    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .insert_scheduled_message(
            "r1",
            "sess-1",
            "hello\u{1b}[31m world\u{7}",
            None,
            "2026-01-01T00:00:10Z",
            "2026-01-01T00:00:00Z",
            Some("tmux"),
            None,
            Some("schedule"),
        )
        .await
        .unwrap();
    let row = store
        .claim_scheduled_message("r1", "sess-1", "2026-01-01T00:01:00Z")
        .await
        .unwrap()
        .unwrap();
    let notify: NotifyScheduled = Arc::new(|_| Box::pin(async {}));
    let handle = TerminalDeliveryHandle::new(
        store.clone(),
        Arc::new(tmux.clone()),
        Arc::new(CatResolver("agent".into())),
        notify,
        None,
    );
    handle.fire(row).await;

    let start = std::time::Instant::now();
    let status = loop {
        let s = store
            .get_scheduled_message("r1")
            .await
            .unwrap()
            .unwrap()
            .status;
        if s != "pending" || start.elapsed() > Duration::from_secs(20) {
            break s;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    handle.shutdown();
    // Give `cat` a moment to flush, then end the isolated server (by its own
    // socket name only).
    tokio::time::sleep(Duration::from_millis(300)).await;
    let got = std::fs::read_to_string(&out).unwrap_or_default();

    assert_eq!(status, "sent");
    assert_eq!(
        got, "hello[31m world\n",
        "exactly once, ESC/BEL stripped, Enter pressed"
    );
}
