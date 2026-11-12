//! Account hand-over plans per harness (multi-account plan A2.T6).
//!
//! The plugin only PLANS the file transfers (`AgentHandover`); applying them is
//! `vst-accounts::handover`. These tests pin each harness's plan against the
//! verified store shapes in `docs/MULTI-ACCOUNT.md` (V5/V6/V8/V10).

mod common;

use std::path::Path;

use vst_agents::{resolve_plugin, SUPPORTED_CLIS};
use vst_types::{
    AccountHandover, Channel, CliId, FileTransfer, HandoverArgs, ResolvedAccount, SessionRecord,
    TransferMode,
};

fn account(cli: &str, dir: &Path) -> ResolvedAccount {
    ResolvedAccount {
        cli: cli.to_string(),
        id: Some("acc_00000001".to_string()),
        dir: Some(dir.to_path_buf()),
        api_key: None,
    }
}

fn session_with_chat(id: &str, chat: &str, channel: Option<Channel>) -> SessionRecord {
    let mut session = common::make_session(id);
    session.agent_chat_id = Some(chat.to_string());
    session.channel = channel;
    session
}

fn files(handover: &AccountHandover) -> &[FileTransfer] {
    match handover {
        AccountHandover::Files(files) => files,
        other => panic!("expected Files, got {other:?}"),
    }
}

#[test]
fn handover_claude_plan_copies_project_file() {
    let from_dir = tempfile::tempdir().unwrap();
    let to_dir = tempfile::tempdir().unwrap();
    let cwd = "/repos/proj";
    let chat = "cccccccc-1111-2222-3333-444444444444";
    // slug = cwd with '/' and '.' replaced by '-'.
    let source = from_dir
        .path()
        .join("projects")
        .join("-repos-proj")
        .join(format!("{chat}.jsonl"));
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(&source, "{\"type\":\"user\"}\n").unwrap();

    let session = session_with_chat("s1", chat, Some(Channel::Json));
    let from = account("claude", from_dir.path());
    let to = account("claude", to_dir.path());
    let plan = resolve_plugin(CliId::Claude).account_session_handover(&HandoverArgs {
        session: &session,
        cwd,
        from: &from,
        to: &to,
    });

    let files = files(&plan);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].from, source);
    assert_eq!(
        files[0].to,
        to_dir
            .path()
            .join("projects")
            .join("-repos-proj")
            .join(format!("{chat}.jsonl"))
    );
    assert_eq!(files[0].mode, TransferMode::Copy);
}

#[test]
fn handover_claude_is_unsupported_without_a_source_file() {
    let from_dir = tempfile::tempdir().unwrap();
    let to_dir = tempfile::tempdir().unwrap();
    let session = session_with_chat("s1", "missing-chat", Some(Channel::Json));
    let plan = resolve_plugin(CliId::Claude).account_session_handover(&HandoverArgs {
        session: &session,
        cwd: "/repos/proj",
        from: &account("claude", from_dir.path()),
        to: &account("claude", to_dir.path()),
    });
    assert_eq!(plan, AccountHandover::Unsupported);
}

#[test]
fn handover_codex_plan_hardlinks_rollout() {
    let from_dir = tempfile::tempdir().unwrap();
    let to_dir = tempfile::tempdir().unwrap();
    let chat = "0192aaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let rollout = from_dir
        .path()
        .join("sessions")
        .join("2026/11/12")
        .join(format!("rollout-2026-11-12T10-00-00-{chat}.jsonl"));
    std::fs::create_dir_all(rollout.parent().unwrap()).unwrap();
    std::fs::write(&rollout, "{\"type\":\"session_meta\"}\n").unwrap();

    // Terminal codex resumes by its native rollout id (V5).
    let session = session_with_chat("s1", chat, Some(Channel::Tmux));
    let plan = resolve_plugin(CliId::Codex).account_session_handover(&HandoverArgs {
        session: &session,
        cwd: "/repos/proj",
        from: &account("codex", from_dir.path()),
        to: &account("codex", to_dir.path()),
    });

    let files = files(&plan);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].from, rollout);
    assert_eq!(
        files[0].to,
        to_dir
            .path()
            .join("sessions")
            .join("2026/11/12")
            .join(rollout.file_name().unwrap())
    );
    assert_eq!(files[0].mode, TransferMode::HardLink);
}

#[test]
fn handover_codex_rich_chat_is_unsupported() {
    // V5: no evidence the ACP port loads a rollout from another CODEX_HOME, so
    // Rich Chat switches are transcript-only.
    let from_dir = tempfile::tempdir().unwrap();
    let chat = "0192aaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let rollout = from_dir
        .path()
        .join("sessions")
        .join("2026/11/12")
        .join(format!("rollout-2026-11-12T10-00-00-{chat}.jsonl"));
    std::fs::create_dir_all(rollout.parent().unwrap()).unwrap();
    std::fs::write(&rollout, "{}\n").unwrap();

    let session = session_with_chat("s1", chat, Some(Channel::Json));
    let to_dir = tempfile::tempdir().unwrap();
    let plan = resolve_plugin(CliId::Codex).account_session_handover(&HandoverArgs {
        session: &session,
        cwd: "/repos/proj",
        from: &account("codex", from_dir.path()),
        to: &account("codex", to_dir.path()),
    });
    assert_eq!(plan, AccountHandover::Unsupported);
}

#[test]
fn handover_cursor_unsupported() {
    let session = session_with_chat("s1", "chat-1", Some(Channel::Json));
    let from = ResolvedAccount::system("cursor");
    let to = ResolvedAccount::system("cursor");
    assert_eq!(
        resolve_plugin(CliId::Cursor).account_session_handover(&HandoverArgs {
            session: &session,
            cwd: "/repos/proj",
            from: &from,
            to: &to,
        }),
        AccountHandover::Unsupported
    );
}

#[test]
fn handover_opencode_unsupported() {
    let session = session_with_chat("s1", "chat-1", Some(Channel::Json));
    let from = ResolvedAccount::system("opencode");
    let to = ResolvedAccount::system("opencode");
    assert_eq!(
        resolve_plugin(CliId::Opencode).account_session_handover(&HandoverArgs {
            session: &session,
            cwd: "/repos/proj",
            from: &from,
            to: &to,
        }),
        AccountHandover::Unsupported
    );
}

#[test]
fn handover_omp_in_place() {
    let session = session_with_chat("s1", "chat-1", Some(Channel::Json));
    let from = ResolvedAccount::system("omp");
    let to = ResolvedAccount::system("omp");
    assert_eq!(
        resolve_plugin(CliId::Omp).account_session_handover(&HandoverArgs {
            session: &session,
            cwd: "/repos/proj",
            from: &from,
            to: &to,
        }),
        AccountHandover::InPlace
    );
}

#[test]
fn handover_pi_copies_by_suffix() {
    let from_dir = tempfile::tempdir().unwrap();
    let to_dir = tempfile::tempdir().unwrap();
    let chat = "sess-123";
    let source = from_dir
        .path()
        .join("sessions")
        .join("-repos-proj")
        .join("2026-11-12T10-00-00-000Z_sess-123.jsonl");
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(&source, "{\"type\":\"session\"}\n").unwrap();

    let session = session_with_chat("s1", chat, Some(Channel::Tmux));
    let plan = resolve_plugin(CliId::Pi).account_session_handover(&HandoverArgs {
        session: &session,
        cwd: "/repos/proj",
        from: &account("pi", from_dir.path()),
        to: &account("pi", to_dir.path()),
    });

    let files = files(&plan);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].from, source);
    assert_eq!(
        files[0].to,
        to_dir
            .path()
            .join("sessions")
            .join("2026-11-12T10-00-00-000Z_sess-123.jsonl"),
        "pi finds the file by suffix under the whole sessions root"
    );
    assert_eq!(files[0].mode, TransferMode::Copy);
}

#[test]
fn handover_needs_a_chat_id_for_every_native_harness() {
    for cli in SUPPORTED_CLIS {
        let session = common::make_session("s1"); // no agent_chat_id
        let from = ResolvedAccount::system(cli.as_str());
        let to = ResolvedAccount::system(cli.as_str());
        let plan = resolve_plugin(cli).account_session_handover(&HandoverArgs {
            session: &session,
            cwd: "/repos/proj",
            from: &from,
            to: &to,
        });
        assert!(
            matches!(
                plan,
                AccountHandover::Unsupported | AccountHandover::InPlace
            ),
            "{cli:?} must not plan a file copy without a conversation"
        );
    }
}

#[test]
fn claude_handover_finds_conversation_under_any_slug() {
    let from_dir = tempfile::tempdir().unwrap();
    let to_dir = tempfile::tempdir().unwrap();
    let chat = "dddddddd-1111-2222-3333-444444444444";
    // Claude canonicalised the cwd `/var/a_b/.x` and replaced every
    // non-alphanumeric character; the slug is found, not derived.
    let source = from_dir
        .path()
        .join("projects")
        .join("-private-var-a-b--x")
        .join(format!("{chat}.jsonl"));
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(&source, "{}\n").unwrap();
    let session = session_with_chat("s1", chat, Some(Channel::Json));
    let plan = resolve_plugin(CliId::Claude).account_session_handover(&HandoverArgs {
        session: &session,
        cwd: "/var/a_b/.x",
        from: &account("claude", from_dir.path()),
        to: &account("claude", to_dir.path()),
    });
    let files = files(&plan);
    assert_eq!(files[0].from, source);
    assert_eq!(
        files[0].to,
        to_dir
            .path()
            .join("projects/-private-var-a-b--x")
            .join(format!("{chat}.jsonl"))
    );
}

#[test]
fn claude_handover_to_system_targets_dot_claude() {
    let from_dir = tempfile::tempdir().unwrap();
    let chat = "eeeeeeee-1111-2222-3333-444444444444";
    let source = from_dir
        .path()
        .join("projects/-repos-proj")
        .join(format!("{chat}.jsonl"));
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(&source, "{}\n").unwrap();
    let mut session = session_with_chat("s1", chat, Some(Channel::Json));
    // The ACP id is used when no native chat id is stored.
    session.acp_session_id = session.agent_chat_id.take();
    let plan = resolve_plugin(CliId::Claude).account_session_handover(&HandoverArgs {
        session: &session,
        cwd: "/repos/proj",
        from: &account("claude", from_dir.path()),
        to: &ResolvedAccount::system("claude"),
    });
    let files = files(&plan);
    assert_eq!(
        files[0].to,
        vst_agents::home::home_dir()
            .join(".claude/projects/-repos-proj")
            .join(format!("{chat}.jsonl"))
    );
}

#[test]
fn claude_handover_rejects_path_like_chat_id() {
    let from_dir = tempfile::tempdir().unwrap();
    let to_dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(from_dir.path().join("projects/p")).unwrap();
    std::fs::write(from_dir.path().join("projects/p/x.jsonl"), "{}\n").unwrap();
    for bad in ["", "../p/x", "p/x", "a\\b", ".."] {
        let session = session_with_chat("s1", bad, Some(Channel::Json));
        let plan = resolve_plugin(CliId::Claude).account_session_handover(&HandoverArgs {
            session: &session,
            cwd: "/repos/proj",
            from: &account("claude", from_dir.path()),
            to: &account("claude", to_dir.path()),
        });
        assert_eq!(plan, AccountHandover::Unsupported, "{bad:?}");
    }
}
