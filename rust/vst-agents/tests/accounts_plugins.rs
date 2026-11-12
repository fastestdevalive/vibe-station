//! The account seam across all seven harnesses (multi-account plan A2.T1/T2).
//!
//! Every harness-specific account fact is an `AgentPlugin` method (R1); this
//! test pins the DECLARATIONS — support, login argv, switch support, env var
//! names, shared entries — so a plugin cannot silently lose one.

mod common;

use std::collections::BTreeMap;
use std::path::PathBuf;

use vst_agents::{resolve_plugin, SUPPORTED_CLIS};
use vst_types::rest::modes::AccountSwitchSupport;
use vst_types::{
    AccountHandover, AccountIdentity, CliId, HandoverArgs, ResolvedAccount, SharedSet,
};

fn named(cli: &str) -> ResolvedAccount {
    ResolvedAccount {
        cli: cli.to_string(),
        id: Some("acc_00000001".to_string()),
        dir: Some(PathBuf::from("/accounts").join(cli).join("acc_00000001")),
        api_key: None,
    }
}

fn handover_args<'a>(
    session: &'a vst_types::SessionRecord,
    from: &'a ResolvedAccount,
    to: &'a ResolvedAccount,
) -> HandoverArgs<'a> {
    HandoverArgs {
        session,
        cwd: "/repos/p1",
        from,
        to,
    }
}

#[test]
fn every_plugin_declares_accounts_consistently() {
    let session = common::make_session("s1");
    for cli in SUPPORTED_CLIS {
        let plugin = resolve_plugin(cli);
        let acct = named(cli.as_str());
        if plugin.supports_accounts() {
            assert!(
                plugin.account_login_command(&acct).is_some(),
                "{cli:?} supports accounts but has no login argv"
            );
            assert_eq!(
                plugin.accounts_unsupported_reason(),
                None,
                "{cli:?} supports accounts and must not carry a reason"
            );
        } else {
            let reason = plugin
                .accounts_unsupported_reason()
                .expect("an unsupported CLI must say why");
            assert!(!reason.trim().is_empty(), "{cli:?} reason is empty");
            assert_eq!(
                plugin.account_switch_support(),
                AccountSwitchSupport::None,
                "none iff supports_accounts is false ({cli:?})"
            );
        }

        // The remaining seam methods must be callable and tolerant for every
        // CLI (a default body, or a real parse that degrades to "unknown").
        assert_eq!(
            plugin.parse_account_identity("", false),
            AccountIdentity::default(),
            "{cli:?} must not invent an identity"
        );
        assert!(
            plugin
                .account_session_handover(&handover_args(&session, &acct, &named(cli.as_str())))
                .is_ok_or_unsupported(),
            "{cli:?} handover must be a valid answer"
        );
        assert_eq!(
            plugin.account_limit_signal("session/update", &serde_json::json!({})),
            None,
            "{cli:?} must ignore a non-limit notification"
        );
    }
}

/// `get_limits_with_env` spawns the vendor CLI for claude/codex/agy, so it is
/// only exercised for the CLIs whose default implementation answers
/// `unsupported` without a process — never exhaust a real account here.
#[tokio::test]
async fn unsupported_clis_have_no_limits_probe() {
    for cli in [CliId::Cursor, CliId::Opencode, CliId::Omp, CliId::Pi] {
        let plugin = resolve_plugin(cli);
        let result = plugin.get_limits_with_env(BTreeMap::new()).await;
        assert_eq!(
            result.status,
            vst_types::LimitStatus::Unsupported,
            "{cli:?} has no limits probe"
        );
    }
}

/// `AccountHandover` has no `is_ok`; this keeps the assertion readable.
trait HandoverExt {
    fn is_ok_or_unsupported(&self) -> bool;
}

impl HandoverExt for AccountHandover {
    fn is_ok_or_unsupported(&self) -> bool {
        matches!(
            self,
            AccountHandover::Unsupported | AccountHandover::InPlace | AccountHandover::Files(_)
        )
    }
}

#[test]
fn six_non_agy_clis_support_accounts() {
    for cli in [
        CliId::Claude,
        CliId::Codex,
        CliId::Cursor,
        CliId::Opencode,
        CliId::Omp,
        CliId::Pi,
    ] {
        assert!(
            resolve_plugin(cli).supports_accounts(),
            "{cli:?} must support accounts"
        );
    }
    // agy is the one allowed shortfall (V9: no dedicated config env).
    assert!(!resolve_plugin(CliId::Agy).supports_accounts());
}

#[test]
fn switch_support_matches_the_harness_facts() {
    for cli in [CliId::Claude, CliId::Codex, CliId::Omp, CliId::Pi] {
        assert_eq!(
            resolve_plugin(cli).account_switch_support(),
            AccountSwitchSupport::Native,
            "{cli:?}"
        );
    }
    for cli in [CliId::Cursor, CliId::Opencode] {
        assert_eq!(
            resolve_plugin(cli).account_switch_support(),
            AccountSwitchSupport::Transcript,
            "{cli:?}"
        );
    }
    assert_eq!(
        resolve_plugin(CliId::Agy).account_switch_support(),
        AccountSwitchSupport::None
    );
}

#[test]
fn account_env_claude_sets_config_dir() {
    let plugin = resolve_plugin(CliId::Claude);
    let acct = named("claude");
    assert_eq!(
        plugin.account_env(&acct),
        BTreeMap::from([(
            "CLAUDE_CONFIG_DIR".to_string(),
            "/accounts/claude/acc_00000001".to_string()
        )])
    );
    assert_eq!(plugin.account_api_key_env(), Some("ANTHROPIC_API_KEY"));
}

#[test]
fn account_env_codex_sets_codex_home() {
    let plugin = resolve_plugin(CliId::Codex);
    let acct = named("codex");
    assert_eq!(
        plugin.account_env(&acct),
        BTreeMap::from([(
            "CODEX_HOME".to_string(),
            "/accounts/codex/acc_00000001".to_string()
        )])
    );
    assert_eq!(plugin.account_api_key_env(), Some("OPENAI_API_KEY"));
}

#[test]
fn account_env_cursor_sets_xdg_config_home() {
    let plugin = resolve_plugin(CliId::Cursor);
    let acct = named("cursor");
    assert_eq!(
        plugin.account_env(&acct),
        BTreeMap::from([(
            "XDG_CONFIG_HOME".to_string(),
            "/accounts/cursor/acc_00000001".to_string()
        )])
    );
    assert_eq!(plugin.account_api_key_env(), Some("CURSOR_API_KEY"));
}

#[test]
fn account_env_agy_never_sets_home() {
    let plugin = resolve_plugin(CliId::Agy);
    for acct in [named("agy"), ResolvedAccount::system("agy")] {
        let env = plugin.account_env(&acct);
        assert!(
            !env.contains_key("HOME"),
            "agy must never shadow HOME (V9): {env:?}"
        );
        assert!(env.is_empty(), "agy has no account env: {env:?}");
    }
}

#[test]
fn opencode_shares_other_tools_data_except_its_own() {
    let entries = resolve_plugin(CliId::Opencode)
        .account_shared_entries()
        .expect("opencode shares the rest of ~/.local/share");
    assert_eq!(entries.set, SharedSet::AllExcept(vec!["opencode"]));
    assert!(entries.source_dir.ends_with(".local/share"));
}

#[test]
fn cursor_shared_entries_all_except_cursor() {
    let entries = resolve_plugin(CliId::Cursor)
        .account_shared_entries()
        .expect("cursor shares the rest of ~/.config");
    assert_eq!(
        entries.set,
        SharedSet::AllExcept(vec!["cursor"]),
        "a private XDG_CONFIG_HOME would hide gh/git from the agent's tools (V6)"
    );
    assert!(entries.source_dir.ends_with(".config"));
}

#[test]
fn account_env_omp_pi_set_agent_dir() {
    for cli in [CliId::Omp, CliId::Pi] {
        let plugin = resolve_plugin(cli);
        let acct = named(cli.as_str());
        assert_eq!(
            plugin.account_env(&acct),
            BTreeMap::from([(
                "PI_CODING_AGENT_DIR".to_string(),
                format!("/accounts/{}/acc_00000001", cli.as_str())
            )]),
            "{cli:?}"
        );
        assert_eq!(plugin.account_api_key_env(), None, "{cli:?} has no API key");
    }
}

#[test]
fn account_env_opencode_sets_data_dir() {
    let plugin = resolve_plugin(CliId::Opencode);
    let acct = named("opencode");
    assert_eq!(
        plugin.account_env(&acct),
        BTreeMap::from([(
            "XDG_DATA_HOME".to_string(),
            "/accounts/opencode/acc_00000001".to_string()
        )])
    );
    // V7 found no API-key env var for opencode.
    assert_eq!(plugin.account_api_key_env(), None);
}

#[test]
fn account_env_system_is_empty_for_all() {
    for cli in SUPPORTED_CLIS {
        let plugin = resolve_plugin(cli);
        let system = ResolvedAccount::system(cli.as_str());
        assert!(
            plugin.account_env(&system).is_empty(),
            "{cli:?}: the System login must not override the daemon env"
        );
    }
}

#[test]
fn codex_launch_command_resumes_from_the_account_store() {
    const ID: &str = "01a0ffb0-70ee-7ac0-86ea-d98c15c32eaf";
    let account = tempfile::tempdir().unwrap();
    let day = account.path().join("sessions/2026/01/01");
    std::fs::create_dir_all(&day).unwrap();
    std::fs::write(
        day.join(format!("rollout-2026-01-01T00-00-00-{ID}.jsonl")),
        b"",
    )
    .unwrap();
    let elsewhere = tempfile::tempdir().unwrap();

    let launch = |dir: &std::path::Path| {
        let mut session = common::make_session("s1");
        session.agent_chat_id = Some(ID.to_string());
        let mut cfg = common::wt_launch("p1", session, "/tmp/wt");
        cfg.account_dir = Some(dir.to_path_buf());
        resolve_plugin(CliId::Codex).get_launch_command(&cfg)
    };
    let argv = launch(account.path());
    assert!(
        argv.windows(2).any(|w| w == ["resume", ID]),
        "resumes from the account's own store: {argv:?}"
    );
    let argv = launch(elsewhere.path());
    assert!(!argv.iter().any(|a| a == "resume"), "{argv:?}");
}

const XDG_NOTE: &str = "This is an XDG root: tools such as gh and git read their config from it, so a new folder hides that from the agent.";

#[test]
fn link_meta_per_harness() {
    use vst_agents::home::home_dir;
    let home = home_dir();
    // (cli, field label, example, system dir under home, note)
    let rows: [(CliId, &str, &str, &str, Option<&str>); 6] = [
        (
            CliId::Claude,
            "Claude config folder",
            "~/.claude-work",
            ".claude",
            None,
        ),
        (
            CliId::Codex,
            "Codex home folder",
            "~/.codex-work",
            ".codex",
            None,
        ),
        (
            CliId::Cursor,
            "XDG root folder",
            "~/cursor-work-config",
            ".config",
            Some(XDG_NOTE),
        ),
        (
            CliId::Opencode,
            "XDG root folder",
            "~/opencode-work-data",
            ".local/share",
            Some(XDG_NOTE),
        ),
        (
            CliId::Omp,
            "Agent folder",
            "~/.omp-work",
            ".omp/agent",
            None,
        ),
        (CliId::Pi, "Agent folder", "~/.pi-work", ".pi/agent", None),
    ];
    for (cli, label, example, system, note) in rows {
        let meta = resolve_plugin(cli).account_link_meta();
        assert_eq!(meta.field_label, label, "{cli:?}");
        assert_eq!(meta.example_path, example, "{cli:?}");
        assert_eq!(meta.system_dir, Some(home.join(system)), "{cli:?}");
        assert_eq!(meta.field_note.as_deref(), note, "{cli:?}");
        assert!(
            !meta.verifies_identity,
            "the daemon sets this, not the plugin"
        );
    }
    let agy = resolve_plugin(CliId::Agy).account_link_meta();
    assert_eq!(agy.field_label, "Folder", "agy keeps the default label");
    assert_eq!(agy.field_note, None);
}

#[test]
fn xdg_roots_carry_field_note_others_none() {
    for cli in SUPPORTED_CLIS {
        let note = resolve_plugin(cli).account_link_meta().field_note;
        let xdg = matches!(cli, CliId::Cursor | CliId::Opencode);
        assert_eq!(note.is_some(), xdg, "{cli:?}");
    }
}

#[test]
fn looks_valid_names_only() {
    let cases: [(CliId, &str); 6] = [
        (CliId::Claude, ".claude.json"),
        (CliId::Codex, "history.jsonl"),
        (CliId::Cursor, "cursor"),
        (CliId::Opencode, "opencode"),
        (CliId::Omp, "skills"),
        (CliId::Pi, "settings.json"),
    ];
    for (cli, name) in cases {
        let plugin = resolve_plugin(cli);
        assert!(
            plugin.account_folder_looks_valid(&[name.to_string()]),
            "{cli:?} {name}"
        );
        assert!(
            !plugin.account_folder_looks_valid(&["foo".to_string()]),
            "{cli:?}"
        );
    }
}

#[test]
fn sign_in_hint_only_pi_omp() {
    for cli in SUPPORTED_CLIS {
        let hint = resolve_plugin(cli).account_sign_in_hint();
        let expected = matches!(cli, CliId::Omp | CliId::Pi);
        assert_eq!(hint.is_some(), expected, "{cli:?}");
        if expected {
            assert_eq!(hint, Some("Run the command, then use /login inside."));
        }
    }
}

#[test]
fn claude_env_unset_non_system_only() {
    let plugin = resolve_plugin(CliId::Claude);
    let three = vec![
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
    ];
    assert_eq!(
        plugin.account_env_unset(&ResolvedAccount::system("claude")),
        Vec::<&str>::new()
    );
    assert_eq!(plugin.account_env_unset(&named("claude")), three);
    let keyed = ResolvedAccount {
        api_key: Some(vst_types::ApiKey::from("sk-test".to_string())),
        ..named("claude")
    };
    assert_eq!(
        plugin.account_env_unset(&keyed),
        vec!["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
        "the account's own API key is set after the unset, so it is kept"
    );
    for cli in SUPPORTED_CLIS.into_iter().filter(|c| *c != CliId::Claude) {
        assert_eq!(
            resolve_plugin(cli).account_env_unset(&named(cli.as_str())),
            Vec::<&str>::new()
        );
    }
}

#[test]
fn only_claude_carries_a_first_run_note() {
    for cli in SUPPORTED_CLIS {
        let note = resolve_plugin(cli).account_link_meta().first_run_note;
        if cli == CliId::Claude {
            assert!(note.is_some_and(|n| n.contains("first-run")), "claude");
        } else {
            assert_eq!(note, None, "{cli:?}");
        }
    }
}
