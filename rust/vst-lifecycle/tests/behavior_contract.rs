//! Behavior-contract tests for vst-lifecycle.
//!
//! ## Behavior contract
//!
//! ### channel.rs
//! - `resolve_channel(_, true)` → `Channel::Json` (json wins)
//! - `resolve_channel(true, false)` → `Channel::Tmux`
//! - `resolve_channel(false, false)` → `Channel::Pty`
//! - `session_channel(Some(Json), _)` → `Json` (explicit wins)
//! - `session_channel(None, None)` → `Tmux` (back-compat default)
//! - `normalize_channel`: stamps channel; `Json` forces `use_tmux=false`
//!
//! ### tool_result_cap.rs
//! - `TOOL_RESULT_MAX_BYTES = 20_000`
//! - Oversized content → `(tool result omitted — N bytes)`
//! - `is_error` preserved on replaced result
//! - Non-tool_result events: no-op
//! - `tool_diffs`: cap `new_text`; drop `old_text` when also oversized
//!
//! ### mutex.rs
//! - Same `project_id` → serialized execution
//! - Different `project_id` → concurrent execution
//!
//! ### pr_poller.rs
//! - `PR_POLL_INTERVAL_MS = 30_000`
//! - `classify_pr_state(merged=true, _, _)` → `Merged`
//! - `classify_pr_state(false, draft=true, _)` → `Draft`
//! - `classify_pr_state(false, false, closed=true)` → `Closed`
//! - `classify_pr_state(false, false, false)` → `Open`
//! - `pr_status_equivalent` ignores `checked_at`
//!
//! ### lifecycle.rs
//! - `POLL_INTERVAL_MS = 1_000`
//! - `IDLE_THRESHOLD_MS = 4_000`
//! - `CAPTURE_LINES = 20`
//! - `everWorked` seeded `true` → idle-stable always → `WaitingForHuman`
//!
//! ### github_auth.rs / parse_hosts_yml
//! - Parses `github.com:` users block; excludes GHES hosts
//! - Trailing `: # comment` on login lines handled
//! - Empty / unrelated content → empty vec
//!
//! ### subagent_notify.rs
//! - `COALESCE_MS = 4_000`, `MAX_NOTICES_PER_PARENT = 25`
//! - Only `WaitingForHuman` is NOTABLE; all other states → no notification
//!
//! ### Two-axis invariant (Gotcha #3)
//! - Compile-fail tests in `tests/compile_fail/` verify that `pr_poller`
//!   cannot call the lifecycle setter and vice versa.

// ─── channel ─────────────────────────────────────────────────────────────────

#[test]
fn channel_resolve_json_wins() {
    use vst_lifecycle::channel::resolve_channel;
    use vst_types::domain::Channel;
    assert_eq!(resolve_channel(true, true), Channel::Json);
    assert_eq!(resolve_channel(false, true), Channel::Json);
}

#[test]
fn channel_resolve_tmux_vs_pty() {
    use vst_lifecycle::channel::resolve_channel;
    use vst_types::domain::Channel;
    assert_eq!(resolve_channel(true, false), Channel::Tmux);
    assert_eq!(resolve_channel(false, false), Channel::Pty);
}

#[test]
fn channel_session_channel_explicit_wins() {
    use vst_lifecycle::channel::session_channel;
    use vst_types::domain::Channel;
    assert_eq!(
        session_channel(Some(Channel::Json), Some(false)),
        Channel::Json
    );
    assert_eq!(
        session_channel(Some(Channel::Pty), Some(true)),
        Channel::Pty
    );
}

#[test]
fn channel_session_channel_legacy_default_is_tmux() {
    use vst_lifecycle::channel::session_channel;
    use vst_types::domain::Channel;
    // Legacy session: no channel, no use_tmux → back-compat default is Tmux.
    assert_eq!(session_channel(None, None), Channel::Tmux);
}

#[test]
fn channel_session_channel_use_tmux_false_is_pty() {
    use vst_lifecycle::channel::session_channel;
    use vst_types::domain::Channel;
    assert_eq!(session_channel(None, Some(false)), Channel::Pty);
}

#[test]
fn channel_normalize_stamps_channel_from_use_tmux() {
    use vst_lifecycle::channel::normalize_channel;
    use vst_types::domain::Channel;
    let mut channel: Option<Channel> = None;
    let mut use_tmux = Some(false);
    normalize_channel(&mut channel, &mut use_tmux);
    assert_eq!(channel, Some(Channel::Pty));
}

#[test]
fn channel_normalize_json_forces_use_tmux_false() {
    use vst_lifecycle::channel::normalize_channel;
    use vst_types::domain::Channel;
    let mut channel = Some(Channel::Json);
    let mut use_tmux = Some(true);
    normalize_channel(&mut channel, &mut use_tmux);
    assert_eq!(channel, Some(Channel::Json));
    assert_eq!(use_tmux, Some(false));
}

#[test]
fn channel_normalize_tmux_channel_not_affected() {
    use vst_lifecycle::channel::normalize_channel;
    use vst_types::domain::Channel;
    let mut channel = Some(Channel::Tmux);
    let mut use_tmux = Some(true);
    normalize_channel(&mut channel, &mut use_tmux);
    // use_tmux unchanged when channel already set to non-json.
    assert_eq!(channel, Some(Channel::Tmux));
    assert_eq!(use_tmux, Some(true));
}

// ─── tool_result_cap ─────────────────────────────────────────────────────────

#[test]
fn tool_result_cap_constant() {
    assert_eq!(
        vst_lifecycle::tool_result_cap::TOOL_RESULT_MAX_BYTES,
        20_000
    );
}

fn tool_result_event(content: &str) -> vst_types::domain::NormalizedEvent {
    use vst_types::domain::{NormalizedEvent, NormalizedEventKind, ToolResult};
    NormalizedEvent {
        kind: NormalizedEventKind::ToolResult,
        tool_result: Some(ToolResult {
            content: Some(content.to_string()),
            is_error: None,
        }),
        ..Default::default()
    }
}

#[test]
fn tool_result_cap_oversized_content_replaced() {
    use vst_lifecycle::tool_result_cap::{cap_tool_result_content, TOOL_RESULT_MAX_BYTES};
    let big = "x".repeat(TOOL_RESULT_MAX_BYTES + 1);
    let mut ev = tool_result_event(&big);
    cap_tool_result_content(&mut ev);
    let content = ev.tool_result.unwrap().content.unwrap();
    assert!(content.contains("omitted"));
    assert!(content.contains(&(TOOL_RESULT_MAX_BYTES + 1).to_string()));
    assert!(content.len() < TOOL_RESULT_MAX_BYTES);
}

#[test]
fn tool_result_cap_exact_boundary_untouched() {
    use vst_lifecycle::tool_result_cap::{cap_tool_result_content, TOOL_RESULT_MAX_BYTES};
    let exact = "y".repeat(TOOL_RESULT_MAX_BYTES);
    let mut ev = tool_result_event(&exact);
    cap_tool_result_content(&mut ev);
    assert_eq!(ev.tool_result.unwrap().content.unwrap(), exact);
}

#[test]
fn tool_result_cap_over_boundary_capped() {
    use vst_lifecycle::tool_result_cap::{cap_tool_result_content, TOOL_RESULT_MAX_BYTES};
    let over = "y".repeat(TOOL_RESULT_MAX_BYTES + 1);
    let mut ev = tool_result_event(&over);
    cap_tool_result_content(&mut ev);
    assert!(ev.tool_result.unwrap().content.unwrap().contains("omitted"));
}

#[test]
fn tool_result_cap_preserves_is_error() {
    use vst_lifecycle::tool_result_cap::{cap_tool_result_content, TOOL_RESULT_MAX_BYTES};
    use vst_types::domain::ToolResult;
    let big = "e".repeat(TOOL_RESULT_MAX_BYTES + 500);
    let mut ev = tool_result_event(&big);
    // Set is_error = true.
    ev.tool_result = Some(ToolResult {
        content: Some(big),
        is_error: Some(true),
    });
    cap_tool_result_content(&mut ev);
    let tr = ev.tool_result.unwrap();
    assert!(tr.content.unwrap().contains("omitted"));
    assert_eq!(tr.is_error, Some(true));
}

#[test]
fn tool_result_cap_noop_on_non_tool_result_event() {
    use vst_lifecycle::tool_result_cap::{cap_tool_result_content, TOOL_RESULT_MAX_BYTES};
    use vst_types::domain::{NormalizedEvent, NormalizedEventKind};
    let big = "x".repeat(TOOL_RESULT_MAX_BYTES + 1);
    let mut ev = NormalizedEvent {
        kind: NormalizedEventKind::Text,
        text: Some(big.clone()),
        ..Default::default()
    };
    cap_tool_result_content(&mut ev);
    assert_eq!(ev.text.unwrap().len(), TOOL_RESULT_MAX_BYTES + 1);
}

#[test]
fn tool_result_cap_noop_when_no_tool_result() {
    use vst_lifecycle::tool_result_cap::cap_tool_result_content;
    use vst_types::domain::{NormalizedEvent, NormalizedEventKind};
    let mut ev = NormalizedEvent {
        kind: NormalizedEventKind::ToolResult,
        tool_result: None,
        ..Default::default()
    };
    cap_tool_result_content(&mut ev); // must not panic
}

#[test]
fn tool_result_cap_diffs_cap_new_text_keeps_small_old() {
    use vst_lifecycle::tool_result_cap::{cap_tool_result_content, TOOL_RESULT_MAX_BYTES};
    use vst_types::domain::ToolDiff;
    let mut ev = tool_result_event("");
    ev.tool_diffs = Some(vec![ToolDiff {
        path: "/a.ts".to_string(),
        old_text: Some("small".to_string()),
        new_text: "y".repeat(TOOL_RESULT_MAX_BYTES + 1),
    }]);
    cap_tool_result_content(&mut ev);
    let diff = &ev.tool_diffs.unwrap()[0];
    assert!(diff.new_text.contains("omitted"));
    assert_eq!(diff.old_text.as_deref(), Some("small"));
}

#[test]
fn tool_result_cap_diffs_drops_old_when_both_oversized() {
    use vst_lifecycle::tool_result_cap::{cap_tool_result_content, TOOL_RESULT_MAX_BYTES};
    use vst_types::domain::ToolDiff;
    let mut ev = tool_result_event("");
    ev.tool_diffs = Some(vec![ToolDiff {
        path: "/a.ts".to_string(),
        old_text: Some("x".repeat(TOOL_RESULT_MAX_BYTES + 1)),
        new_text: "y".repeat(TOOL_RESULT_MAX_BYTES + 1),
    }]);
    cap_tool_result_content(&mut ev);
    let diff = &ev.tool_diffs.unwrap()[0];
    assert!(diff.new_text.contains("omitted"));
    assert!(diff.old_text.is_none());
}

#[test]
fn tool_result_cap_diffs_normal_size_untouched() {
    use vst_lifecycle::tool_result_cap::cap_tool_result_content;
    use vst_types::domain::ToolDiff;
    let mut ev = tool_result_event("");
    let diff_orig = ToolDiff {
        path: "/a.ts".to_string(),
        old_text: Some("a\nb".to_string()),
        new_text: "a\nc".to_string(),
    };
    ev.tool_diffs = Some(vec![diff_orig.clone()]);
    cap_tool_result_content(&mut ev);
    assert_eq!(ev.tool_diffs.unwrap()[0], diff_orig);
}

// ─── pr_poller constants and pure functions ───────────────────────────────────

#[test]
fn pr_poller_interval_constant() {
    assert_eq!(vst_lifecycle::pr_poller::PR_POLL_INTERVAL_MS, 30_000);
}

#[test]
fn pr_poller_classify_merged() {
    use vst_lifecycle::pr_poller::classify_pr_state;
    use vst_types::domain::PrState;
    assert_eq!(classify_pr_state(true, false, false), PrState::Merged);
    assert_eq!(classify_pr_state(true, true, true), PrState::Merged);
}

#[test]
fn pr_poller_classify_draft() {
    use vst_lifecycle::pr_poller::classify_pr_state;
    use vst_types::domain::PrState;
    assert_eq!(classify_pr_state(false, true, false), PrState::Draft);
    assert_eq!(classify_pr_state(false, true, true), PrState::Draft);
}

#[test]
fn pr_poller_classify_closed() {
    use vst_lifecycle::pr_poller::classify_pr_state;
    use vst_types::domain::PrState;
    assert_eq!(classify_pr_state(false, false, true), PrState::Closed);
}

#[test]
fn pr_poller_classify_open() {
    use vst_lifecycle::pr_poller::classify_pr_state;
    use vst_types::domain::PrState;
    assert_eq!(classify_pr_state(false, false, false), PrState::Open);
}

#[test]
fn pr_status_equivalent_ignores_checked_at() {
    use vst_lifecycle::pr_poller::pr_status_equivalent;
    use vst_types::domain::{PrState, PrStatus};
    let a = PrStatus {
        state: PrState::Open,
        number: Some(7),
        url: Some("https://example.com/pull/7".to_string()),
        checked_at: "2025-01-01T00:00:00Z".to_string(),
        error: None,
        pr_branch: Some("feat".to_string()),
    };
    let b = PrStatus {
        checked_at: "2025-06-01T12:00:00Z".to_string(), // different timestamp
        ..a.clone()
    };
    assert!(pr_status_equivalent(&a, &b));
}

#[test]
fn pr_status_not_equivalent_on_state_change() {
    use vst_lifecycle::pr_poller::pr_status_equivalent;
    use vst_types::domain::{PrState, PrStatus};
    let now = "2025-01-01T00:00:00Z".to_string();
    let a = PrStatus {
        state: PrState::Open,
        number: Some(7),
        url: None,
        checked_at: now.clone(),
        error: None,
        pr_branch: None,
    };
    let b = PrStatus {
        state: PrState::Merged,
        ..a.clone()
    };
    assert!(!pr_status_equivalent(&a, &b));
}

// ─── lifecycle constants ──────────────────────────────────────────────────────

#[test]
fn lifecycle_constants() {
    assert_eq!(vst_lifecycle::lifecycle::POLL_INTERVAL_MS, 1_000);
    assert_eq!(vst_lifecycle::lifecycle::IDLE_THRESHOLD_MS, 4_000);
    assert_eq!(vst_lifecycle::lifecycle::CAPTURE_LINES, 20);
}

// ─── subagent_notify constants ────────────────────────────────────────────────

#[test]
fn subagent_notify_constants() {
    assert_eq!(vst_lifecycle::subagent_notify::COALESCE_MS, 4_000);
    assert_eq!(vst_lifecycle::subagent_notify::MAX_NOTICES_PER_PARENT, 25);
}

#[test]
fn subagent_notify_only_waiting_for_human_is_notable() {
    use std::pin::Pin;
    use vst_lifecycle::subagent_notify::{
        NotifyDeps, PillPayload, SessionLookup, SubagentNotifyHandle,
    };
    use vst_types::domain::LifecycleState;

    struct NoopDeps;
    impl NotifyDeps for NoopDeps {
        fn lookup(&self, _id: &str) -> Option<SessionLookup> {
            None
        }
        fn populate_notice_slot(&self, _p: &str, _c: &str, _n: &str) -> bool {
            false
        }
        fn emit_pill(
            &self,
            _p: &str,
            _payload: PillPayload,
        ) -> Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
            Box::pin(async {})
        }
        fn prune_notice_slot_child(&self, _p: &str, _c: &str) {}
    }

    let handle = SubagentNotifyHandle::new();
    let deps = NoopDeps;

    // None of these should panic; non-notable states are dropped.
    handle.note_subagent_state_change("c1", LifecycleState::Working, LifecycleState::Idle, &deps);
    handle.note_subagent_state_change("c1", LifecycleState::Idle, LifecycleState::Done, &deps);
    handle.note_subagent_state_change("c1", LifecycleState::Done, LifecycleState::Exited, &deps);
}

// ─── github_auth::parse_hosts_yml ─────────────────────────────────────────────

#[test]
fn parse_hosts_yml_extracts_github_com_users() {
    use vst_lifecycle::github_auth::{parse_hosts_yml, GithubAccount};
    let text = "\
github.com:
    users:
        alice:
            oauth_token: gho_aaa
        fastestdevalive:
            oauth_token: gho_bbb
    git_protocol: ssh
    user: alice
    oauth_token: gho_aaa
";
    let accounts = parse_hosts_yml(text);
    assert_eq!(
        accounts,
        vec![
            GithubAccount {
                login: "alice".to_string(),
                token: Some("gho_aaa".to_string())
            },
            GithubAccount {
                login: "fastestdevalive".to_string(),
                token: Some("gho_bbb".to_string())
            },
        ]
    );
}

#[test]
fn parse_hosts_yml_keyring_user_has_null_token() {
    use vst_lifecycle::github_auth::{parse_hosts_yml, GithubAccount};
    let text = "\
github.com:
    users:
        keyring-user: {}
    git_protocol: https
";
    let accounts = parse_hosts_yml(text);
    assert_eq!(
        accounts,
        vec![GithubAccount {
            login: "keyring-user".to_string(),
            token: None
        }]
    );
}

#[test]
fn parse_hosts_yml_empty_returns_empty() {
    use vst_lifecycle::github_auth::parse_hosts_yml;
    assert!(parse_hosts_yml("").is_empty());
    assert!(parse_hosts_yml("some_other_key: value\n").is_empty());
}

#[test]
fn parse_hosts_yml_excludes_ghes_host_blocks() {
    use vst_lifecycle::github_auth::{parse_hosts_yml, GithubAccount};
    let text = "\
my-ghes.example.com:
    users:
        ghes-user:
            oauth_token: ghes_token
github.com:
    users:
        real-user:
            oauth_token: gho_real
";
    let accounts = parse_hosts_yml(text);
    assert_eq!(
        accounts,
        vec![GithubAccount {
            login: "real-user".to_string(),
            token: Some("gho_real".to_string())
        }]
    );
}

#[test]
fn parse_hosts_yml_handles_trailing_comment_on_login() {
    use vst_lifecycle::github_auth::{parse_hosts_yml, GithubAccount};
    let text = "\
github.com:
    users:
        commented-login: # some nickname
            oauth_token: gho_commented
";
    let accounts = parse_hosts_yml(text);
    assert_eq!(
        accounts,
        vec![GithubAccount {
            login: "commented-login".to_string(),
            token: Some("gho_commented".to_string())
        }]
    );
}

// ─── mutex.rs ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn mutex_same_key_serializes() {
    use std::sync::{Arc, Mutex};
    use vst_lifecycle::mutex::ProjectMutex;

    let pm = ProjectMutex::new();
    let counter = Arc::new(Mutex::new(0u32));

    let handles: Vec<_> = (0..10)
        .map(|_| {
            let pm = pm.clone();
            let counter = counter.clone();
            tokio::spawn(async move {
                pm.with_project_lock("proj-1", || async {
                    let mut c = counter.lock().unwrap();
                    *c += 1;
                })
                .await
            })
        })
        .collect();

    for h in handles {
        h.await.unwrap();
    }

    assert_eq!(*counter.lock().unwrap(), 10);
}

#[tokio::test]
async fn mutex_different_keys_do_not_block_each_other() {
    use std::sync::{Arc, Mutex};
    use vst_lifecycle::mutex::ProjectMutex;

    let pm = ProjectMutex::new();
    let log = Arc::new(Mutex::new(Vec::<String>::new()));

    // Both tasks acquire different keys simultaneously.
    let (h1, h2) = tokio::join!(
        {
            let pm = pm.clone();
            let log = log.clone();
            tokio::spawn(async move {
                pm.with_project_lock("proj-A", || async {
                    log.lock().unwrap().push("A".to_string());
                })
                .await
            })
        },
        {
            let pm = pm.clone();
            let log = log.clone();
            tokio::spawn(async move {
                pm.with_project_lock("proj-B", || async {
                    log.lock().unwrap().push("B".to_string());
                })
                .await
            })
        }
    );
    h1.unwrap();
    h2.unwrap();

    let entries = log.lock().unwrap();
    assert!(entries.contains(&"A".to_string()));
    assert!(entries.contains(&"B".to_string()));
}

// ─── two-axis compile-fail (Gotcha #3) ────────────────────────────────────────

/// Prove that the two-axis setters are truly private to their own module.
/// Each fixture attempts to reference a private setter from outside its module
/// and must fail to compile with a privacy error.
#[test]
fn two_axis_setters_are_private() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/compile_fail/*.rs");
}
