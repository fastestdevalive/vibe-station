use std::collections::BTreeMap;
use std::path::PathBuf;

use super::*;
use crate::plugin::{
    AsyncResult, ComposePromptInput, ComposePromptResult, LaunchConfig, ListModelsResult,
    PromptDelivery, ReadySignal,
};
use vst_types::{ApiKey, Channel};

const DIR_VAR: &str = "FAKE_ACCOUNT_DIR";
const KEY_VAR: &str = "FAKE_API_KEY";

/// A fake harness whose argv come from the test, so no real CLI is run.
struct FakePlugin {
    login: Option<Vec<String>>,
    identity: Option<Vec<String>>,
    hint: Option<&'static str>,
    /// Names `account_env_unset` reports.
    unset: Vec<&'static str>,
    /// Extra entries `account_env` adds next to the dir var.
    extra_env: BTreeMap<String, String>,
}

impl FakePlugin {
    fn with(login: Vec<String>, identity: Vec<String>) -> Self {
        Self {
            login: Some(login),
            identity: Some(identity),
            hint: None,
            unset: vec![],
            extra_env: BTreeMap::new(),
        }
    }
}

impl AgentPlugin for FakePlugin {
    fn name(&self) -> &str {
        "fake"
    }
    fn default_model(&self) -> &str {
        ""
    }
    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "fake"
    }
    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::Inline
    }
    fn get_launch_command(&self, _cfg: &LaunchConfig) -> Vec<String> {
        vec![]
    }
    fn get_environment(&self, _cfg: &LaunchConfig) -> BTreeMap<String, String> {
        BTreeMap::new()
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
    fn list_models(&self) -> AsyncResult<ListModelsResult> {
        Box::pin(async { ListModelsResult::default() })
    }
    fn account_env(&self, acct: &ResolvedAccount) -> BTreeMap<String, String> {
        let mut env = self.extra_env.clone();
        if let Some(dir) = &acct.dir {
            env.insert(DIR_VAR.to_string(), dir.to_string_lossy().into_owned());
        }
        env
    }
    fn account_env_unset(&self, _acct: &ResolvedAccount) -> Vec<&'static str> {
        self.unset.clone()
    }
    fn account_api_key_env(&self) -> Option<&'static str> {
        Some(KEY_VAR)
    }
    fn account_login_command(&self, _acct: &ResolvedAccount) -> Option<Vec<String>> {
        self.login.clone()
    }
    fn account_identity_command(&self, _acct: &ResolvedAccount) -> Option<Vec<String>> {
        self.identity.clone()
    }
    fn account_sign_in_hint(&self) -> Option<&'static str> {
        self.hint
    }
    fn parse_account_identity(&self, stdout: &str, exit_ok: bool) -> AccountIdentity {
        AccountIdentity {
            signed_in: exit_ok.then_some(true),
            email: Some(format!("{}bytes", stdout.len())),
            plan: None,
        }
    }
}

fn account(dir: &str) -> ResolvedAccount {
    ResolvedAccount {
        cli: "fake".to_string(),
        id: Some("acc_00000001".to_string()),
        dir: Some(PathBuf::from(dir)),
        api_key: Some(ApiKey::from("sk-should-not-leak".to_string())),
    }
}

#[test]
fn login_shell_line_quotes_dir_and_omits_api_key() {
    let plugin = FakePlugin::with(
        vec!["fake".to_string(), "login".to_string()],
        vec!["fake".to_string(), "status".to_string()],
    );
    let line = login_shell_line(&plugin, &account("/tmp/a b/acc_1")).expect("login argv");
    assert!(line.starts_with("exec env "), "{line}");
    assert!(
        line.contains(&format!("{DIR_VAR}='/tmp/a b/acc_1'")),
        "the account dir is single-quoted: {line}"
    );
    assert!(line.contains(" 'fake' 'login'"), "{line}");
    assert!(
        !line.contains("sk-should-not-leak"),
        "no API key in argv: {line}"
    );
    assert!(!line.contains(KEY_VAR), "{line}");
}

#[test]
fn login_shell_line_unsets_before_env() {
    let plugin = FakePlugin {
        unset: vec!["A_TOKEN", "B_TOKEN"],
        ..FakePlugin::with(vec!["fake".to_string()], vec![])
    };
    let line = login_shell_line(&plugin, &account("/tmp/acc_1")).expect("login argv");
    assert!(
        line.starts_with(&format!("exec env -u A_TOKEN -u B_TOKEN {DIR_VAR}=")),
        "unsets come before the K='v' pairs: {line}"
    );
}

#[test]
fn login_shell_line_is_none_without_login_argv() {
    let plugin = FakePlugin {
        login: None,
        identity: None,
        hint: None,
        unset: vec![],
        extra_env: BTreeMap::new(),
    };
    assert_eq!(login_shell_line(&plugin, &account("/tmp/acc_1")), None);
}

#[test]
fn sign_in_steps_command_shape() {
    let plugin = FakePlugin::with(vec!["tool".to_string(), "login".to_string()], vec![]);
    let home = Path::new("/home/u");
    let steps = sign_in_steps(&plugin, &account("/home/u/.x"), home);
    assert_eq!(
        steps.command.as_deref(),
        Some("FAKE_ACCOUNT_DIR=~/.x tool login"),
        "env as K=<display path>, then the argv words, no exec"
    );
    let spaced = sign_in_steps(&plugin, &account("/tmp/a b/acc_1"), home);
    assert_eq!(
        spaced.command.as_deref(),
        Some("FAKE_ACCOUNT_DIR='/tmp/a b/acc_1' tool login"),
        "a path with a space becomes a single-quoted absolute path"
    );
    let system = sign_in_steps(&plugin, &ResolvedAccount::system("fake"), home);
    assert_eq!(system.command.as_deref(), Some("tool login"));
}

#[test]
fn sign_in_command_leaves_safe_words_unquoted() {
    let plugin = FakePlugin::with(
        vec![
            "tool".to_string(),
            "auth".to_string(),
            "a b".to_string(),
            "~/bin/x".to_string(),
        ],
        vec![],
    );
    let steps = sign_in_steps(
        &plugin,
        &account("/home/u/.claude-work"),
        Path::new("/home/u"),
    );
    assert_eq!(
        steps.command.as_deref(),
        Some("FAKE_ACCOUNT_DIR=~/.claude-work tool auth 'a b' ~/bin/x"),
        "safe words stay bare; unsafe ones are quoted"
    );
}

#[test]
fn sign_in_steps_hint_from_plugin() {
    let mut plugin = FakePlugin::with(vec!["tool".to_string()], vec![]);
    let home = Path::new("/home/u");
    assert_eq!(
        sign_in_steps(&plugin, &account("/home/u/.x"), home).hint,
        None
    );
    plugin.hint = Some("Run the command, then use /login inside.");
    assert_eq!(
        sign_in_steps(&plugin, &account("/home/u/.x"), home)
            .hint
            .as_deref(),
        Some("Run the command, then use /login inside.")
    );
}

#[test]
fn sign_in_steps_without_login_argv_has_no_command() {
    let plugin = FakePlugin {
        login: None,
        identity: None,
        hint: None,
        unset: vec![],
        extra_env: BTreeMap::new(),
    };
    let steps = sign_in_steps(&plugin, &account("/home/u/.x"), Path::new("/home/u"));
    assert_eq!(steps.command, None);
}

#[test]
fn display_path_cases() {
    let home = Path::new("/home/u");
    assert_eq!(
        display_path(Path::new("/home/u/.claude-work"), home),
        "~/.claude-work"
    );
    assert_eq!(display_path(home, home), "~");
    assert_eq!(display_path(Path::new("/home/ux/x"), home), "/home/ux/x");
    assert_eq!(display_path(Path::new("/opt/x"), home), "/opt/x");
    assert_eq!(
        display_path(Path::new("/home/u/a b"), home),
        "'/home/u/a b'"
    );
}

#[tokio::test(start_paused = true)]
async fn run_identity_times_out_and_kills() {
    // A real process that never answers: the 10 s bound is virtual time.
    let plugin = FakePlugin::with(
        vec![],
        vec![
            "sh".to_string(),
            "-c".to_string(),
            "sleep 60; echo logged-in".to_string(),
        ],
    );
    let identity = run_identity(&plugin, &account("/tmp/acc_1")).await;
    assert_eq!(identity, AccountIdentity::default(), "timed out = unknown");
}

#[tokio::test]
async fn run_identity_caps_stdout() {
    // ~200 KB of output; the parser only ever sees the cap.
    let plugin = FakePlugin::with(
        vec![],
        vec![
            "sh".to_string(),
            "-c".to_string(),
            "yes x | head -c 200000".to_string(),
        ],
    );
    let identity = run_identity(&plugin, &account("/tmp/acc_1")).await;
    let bytes: usize = identity
        .email
        .as_deref()
        .and_then(|e| e.strip_suffix("bytes"))
        .and_then(|n| n.parse().ok())
        .expect("parser saw stdout");
    assert_eq!(bytes as u64, IDENTITY_MAX_STDOUT, "stdout is capped");
}

#[tokio::test]
async fn run_identity_falls_back_to_stderr() {
    let plugin = FakePlugin::with(
        vec![],
        vec!["sh".to_string(), "-c".to_string(), "echo x >&2".to_string()],
    );
    let identity = run_identity(&plugin, &account("/tmp/acc_1")).await;
    assert_eq!(identity.email.as_deref(), Some("2bytes"));
}

#[tokio::test]
async fn run_identity_removes_unset_vars() {
    // The account env sets LEAKED=1; the unset list must win over it. The fake
    // parser reports the stdout length, so "4bytes" means the word was `none`.
    let plugin = FakePlugin {
        unset: vec!["LEAKED"],
        extra_env: BTreeMap::from([("LEAKED".to_string(), "1".to_string())]),
        ..FakePlugin::with(
            vec![],
            vec![
                "sh".to_string(),
                "-c".to_string(),
                "printf '%s' \"${LEAKED:-none}\"".to_string(),
            ],
        )
    };
    let identity = run_identity(&plugin, &account("/tmp/acc_1")).await;
    assert_eq!(identity.email.as_deref(), Some("4bytes"));
}

#[tokio::test]
async fn run_identity_without_argv_is_unknown() {
    let plugin = FakePlugin {
        login: None,
        identity: None,
        hint: None,
        unset: vec![],
        extra_env: BTreeMap::new(),
    };
    assert_eq!(
        run_identity(&plugin, &account("/tmp/acc_1")).await,
        AccountIdentity::default()
    );
}
