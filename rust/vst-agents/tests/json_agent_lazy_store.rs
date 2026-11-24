//! A live session holds its transcript store only while leased: a running turn,
//! or one read/write call. Per-session seams only; the global open-store gauge
//! is asserted in `json_agent_store_cap.rs` (its own binary).

mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;
use vst_agents::plugin::{
    AgentPlugin, ComposePromptInput, ComposePromptResult, LaunchConfig, ListModelsResult,
    PromptDelivery, ReadySignal, TurnContext, TurnInput,
};
use vst_agents::{create_claude_plugin, json_agent_session::JsonAgentSession};
use vst_types::{Channel, NormalizedEvent, NormalizedEventKind};

/// A turn that starts, waits for `release`, then ends with a Result.
struct GatedPlugin {
    started: Arc<AtomicBool>,
    release: Arc<Notify>,
}

impl AgentPlugin for GatedPlugin {
    fn name(&self) -> &str {
        "gated"
    }
    fn default_model(&self) -> &str {
        "mock-model"
    }
    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "mock"
    }
    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::Inline
    }
    fn get_launch_command(&self, _cfg: &LaunchConfig) -> Vec<String> {
        vec![]
    }
    fn get_environment(&self, _cfg: &LaunchConfig) -> std::collections::BTreeMap<String, String> {
        std::collections::BTreeMap::new()
    }
    fn get_ready_signal(&self) -> ReadySignal {
        ReadySignal {
            sentinel: None,
            fallback_ms: 0,
        }
    }
    fn compose_launch_prompt(&self, _input: ComposePromptInput) -> ComposePromptResult {
        ComposePromptResult::default()
    }
    fn default_channel(&self) -> Channel {
        Channel::Json
    }
    fn list_models(&self) -> vst_agents::plugin::AsyncResult<ListModelsResult> {
        Box::pin(async { ListModelsResult::default() })
    }
    fn supports_json(&self) -> bool {
        true
    }
    fn supports_acp(&self) -> bool {
        true
    }
    fn run_turn(
        &self,
        _input: TurnInput,
        _ctx: TurnContext,
        cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.started.store(true, Ordering::SeqCst);
        let release = self.release.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = cancel.cancelled() => {}
                _ = release.notified() => {
                    let mut ev = NormalizedEvent::default();
                    ev.kind = NormalizedEventKind::Result;
                    let _ = tx.send(ev);
                }
            }
        });
        rx
    }
}

async fn eventually(what: &str, mut cond: impl FnMut() -> bool) {
    for _ in 0..200 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for: {what}");
}

fn setup() -> (
    tempfile::TempDir,
    vst_agents::home::HomeGuard,
    vst_store::StoreHandle,
) {
    let dir = tempfile::tempdir().unwrap();
    let home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    (dir, home, store)
}

#[tokio::test]
async fn a_new_session_and_its_reads_hold_no_store() {
    let (_dir, _home, store) = setup();
    let s = common::seeded_session(&store, "s-lazy", 3, Arc::new(create_claude_plugin()));
    assert!(
        !s.store_is_open_for_test(),
        "construction closes the seed open"
    );
    assert_eq!(s.read_transcript().len(), 3);
    assert!(!s.store_is_open_for_test(), "a read closes it again");
    assert!(!s.has_live_connection_for_test());
}

#[tokio::test]
async fn the_store_is_open_during_a_turn_and_seq_stays_contiguous_across_turns() {
    let (_dir, _home, store) = setup();
    let started = Arc::new(AtomicBool::new(false));
    let release = Arc::new(Notify::new());
    let plugin = GatedPlugin {
        started: started.clone(),
        release: release.clone(),
    };
    let s = common::seeded_session(&store, "s-turns", 0, Arc::new(plugin));

    for turn in 0..2 {
        started.store(false, Ordering::SeqCst);
        s.enqueue(format!("turn {turn}"), vec![], None, None);
        eventually("turn started", || started.load(Ordering::SeqCst)).await;
        assert!(s.store_is_open_for_test(), "open while the turn runs");
        release.notify_one();
        eventually("store closed after the drain", || {
            !s.store_is_open_for_test()
        })
        .await;
    }

    let seqs: Vec<i64> = s
        .read_transcript()
        .iter()
        .map(|e| e.log_seq.unwrap())
        .collect();
    assert!(seqs.len() >= 4, "user + result rows per turn: {seqs:?}");
    assert_eq!(seqs, (0..seqs.len() as i64).collect::<Vec<_>>());
}

#[tokio::test]
async fn out_of_band_events_without_a_lease_persist_contiguously_and_close() {
    let (_dir, _home, store) = setup();
    let s = common::seeded_session(&store, "s-oob", 0, Arc::new(create_claude_plugin()));
    for n in 0..100 {
        let mut e = common::text_event("s-oob", n);
        e.turn_id = None;
        s.handle_out_of_band_event(e);
    }
    assert!(!s.store_is_open_for_test());
    let seqs: Vec<i64> = s
        .read_transcript()
        .iter()
        .map(|e| e.log_seq.unwrap())
        .collect();
    assert!(seqs.len() >= 100);
    assert_eq!(seqs, (0..seqs.len() as i64).collect::<Vec<_>>());
}

#[tokio::test]
async fn a_failed_open_degrades_reads_to_empty_and_leaves_the_session_usable() {
    let (_dir, _home, store) = setup();
    let s: JsonAgentSession =
        common::seeded_session(&store, "s-fail", 2, Arc::new(create_claude_plugin()));
    s.fail_store_opens_for_test();
    assert!(s.lease_store().is_err());
    assert!(s.read_transcript().is_empty());
}
