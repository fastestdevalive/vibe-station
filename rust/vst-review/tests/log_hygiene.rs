//! 5.T14: no message text at info/warn. Its own test binary so a process-global
//! subscriber sees every event (scoped subscribers race tracing's callsite cache
//! when other tests run in parallel).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use vst_proc::tmux::PaneFlags;
use vst_review::{
    BoxFuture, NotifyScheduled, PaneIo, TargetResolver, TerminalDeliveryHandle, TerminalTarget,
};
use vst_store::StoreHandle;
use vst_types::terminal_delivery::{PaneSnapshot, TerminalDeliveryCaps, TerminalReadiness};

#[derive(Clone, Default)]
struct Buf(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for Buf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Buf {
    type Writer = Buf;
    fn make_writer(&'a self) -> Buf {
        self.clone()
    }
}

struct Pane;
impl PaneIo for Pane {
    fn list_session_names(&self) -> Option<HashSet<String>> {
        Some(["agent".to_string()].into_iter().collect())
    }
    fn pane_flags(&self, _: &str) -> Option<PaneFlags> {
        Some(PaneFlags {
            in_mode: false,
            dead: false,
        })
    }
    fn capture(&self, _: &str) -> Result<PaneSnapshot, String> {
        Ok(PaneSnapshot::default())
    }
    fn cancel_mode(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn paste(&self, _: &str, _: &str, _: &str, _: bool) -> Result<(), String> {
        Ok(())
    }
    fn send_enter(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

struct Resolver {
    exited: Mutex<bool>,
}
impl TargetResolver for Resolver {
    fn resolve(&self, _: &str) -> BoxFuture<'_, Option<TerminalTarget>> {
        let exited = *self.exited.lock().unwrap();
        Box::pin(async move {
            Some(TerminalTarget {
                tmux_name: "agent".into(),
                channel_is_tmux: true,
                channel_is_json: false,
                gone: false,
                exited,
                caps: Some(TerminalDeliveryCaps {
                    settle_ms: 10,
                    multiline_ok: true,
                    raw_lf: false,
                }),
                probe: Arc::new(|_| TerminalReadiness::Ready),
            })
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn logs_never_contain_the_message_text() {
    let buf = Buf::default();
    tracing::subscriber::set_global_default(
        tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_max_level(tracing::Level::INFO)
            .finish(),
    )
    .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let resolver = Arc::new(Resolver {
        exited: Mutex::new(false),
    });
    let notify: NotifyScheduled = Arc::new(|_| Box::pin(async {}));
    let handle = TerminalDeliveryHandle::new(
        store.clone(),
        Arc::new(Pane),
        resolver.clone(),
        notify,
        None,
    );

    for (id, text, exited) in [
        ("r1", "SECRET-BODY-ONE", false),
        ("r2", "SECRET-BODY-TWO", true),
    ] {
        *resolver.exited.lock().unwrap() = exited;
        store
            .insert_scheduled_message(
                id,
                "s",
                text,
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
            .claim_scheduled_message(id, "s", "2026-01-01T00:01:00Z")
            .await
            .unwrap()
            .unwrap();
        handle.fire(row).await;
        let start = std::time::Instant::now();
        while store
            .get_scheduled_message(id)
            .await
            .unwrap()
            .unwrap()
            .status
            == "pending"
        {
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "{id} never settled"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    handle.shutdown();

    let logs = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
    assert!(logs.contains("r1") && logs.contains("r2"), "logs: {logs}");
    assert!(!logs.contains("SECRET"), "message text leaked: {logs}");
}
