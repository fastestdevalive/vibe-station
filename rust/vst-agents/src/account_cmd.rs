//! Run a harness's own login / identity commands under an account folder.
//!
//! Two callers: sign-in (a Terminal session pastes [`login_shell_line`]) and
//! the identity check ([`run_identity`], used by the daemon's accounts wiring).
//! Both are CLI-agnostic: the argv and env come from the plugin (R1), and this
//! file contains no harness name.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use vst_types::{collapse_home, AccountIdentity, ResolvedAccount, SignInSteps};

use crate::plugin::AgentPlugin;

/// Budget for one identity command (Decision 12: bounded, never blocks boot).
const IDENTITY_TIMEOUT: Duration = Duration::from_secs(10);
/// Never buffer more than this much of the identity command's stdout.
const IDENTITY_MAX_STDOUT: u64 = 64 * 1024;

/// The shell line that signs `acct` in, or `None` when this CLI has no login
/// argv.
///
/// Shape: `exec env K='v' ... <argv...>` — `exec` makes the login shell
/// disappear when the vendor command ends, so the Terminal session exiting IS
/// the completion signal (Decision 5). Every value is single-quoted through
/// `sq`, and the API key is deliberately NEVER included: it is env-only at
/// spawn time and has nothing to do with signing in (R6).
#[must_use]
pub fn login_shell_line(plugin: &dyn AgentPlugin, acct: &ResolvedAccount) -> Option<String> {
    let argv = plugin.account_login_command(acct)?;
    if argv.is_empty() {
        return None;
    }
    let mut line = String::from("exec");
    let env = plugin.account_env(acct);
    let unset = crate::account_env::account_unset(plugin, acct);
    if !env.is_empty() || !unset.is_empty() {
        line.push_str(" env");
        for name in &unset {
            line.push_str(" -u ");
            line.push_str(name);
        }
        line.push_str(&env_line(&env));
    }
    for arg in &argv {
        line.push(' ');
        line.push_str(&vst_proc::sq(arg));
    }
    Some(line)
}

/// ` K='v'` for every entry, in a stable order.
fn env_line(env: &BTreeMap<String, String>) -> String {
    let mut out = String::new();
    for (key, value) in env {
        out.push(' ');
        out.push_str(key);
        out.push('=');
        out.push_str(&vst_proc::sq(value));
    }
    out
}

/// A folder as the sign-in steps show it (Decision 3): `~/…` when the result
/// holds only plain path characters, otherwise the absolute path single-quoted.
#[must_use]
pub fn display_path(path: &Path, home: &Path) -> String {
    let shown = collapse_home(path, home);
    let plain = shown
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '~' | '-'));
    if plain {
        shown
    } else {
        vst_proc::sq(&path.to_string_lossy())
    }
}

/// One copyable word: plain safe characters stay bare (a leading `~/` path too,
/// so the shell still expands it); anything else goes through `sq`.
fn copy_word(word: &str) -> String {
    let safe = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "_./=:@%+-".contains(c))
    };
    let tilde_path = word.strip_prefix("~/").is_some_and(safe);
    if tilde_path || safe(word) {
        word.to_string()
    } else {
        vst_proc::sq(word)
    }
}

/// The copyable sign-in steps for `acct`, built from the plugin: `K=<dir> <login
/// argv>`. Plain words are left bare and anything else is single-quoted
/// ([`copy_word`]). No `exec` and no unsets (the Terminal tab keeps
/// [`login_shell_line`]). `hint` is the plugin's step-2 sentence.
#[must_use]
pub fn sign_in_steps(plugin: &dyn AgentPlugin, acct: &ResolvedAccount, home: &Path) -> SignInSteps {
    let command = plugin
        .account_login_command(acct)
        .filter(|argv| !argv.is_empty())
        .map(|argv| {
            let mut words: Vec<String> = plugin
                .account_env(acct)
                .iter()
                .map(|(key, value)| format!("{key}={}", display_path(Path::new(value), home)))
                .collect();
            words.extend(argv.iter().map(|arg| copy_word(arg)));
            words.join(" ")
        });
    SignInSteps {
        command,
        hint: plugin.account_sign_in_hint().map(str::to_string),
    }
}

/// Run `acct`'s read-only identity command and parse its answer.
///
/// Contract: bounded by [`IDENTITY_TIMEOUT`] with `kill_on_drop`; stdout and
/// stderr each capped at [`IDENTITY_MAX_STDOUT`]; the parser gets stdout, or stderr
/// when stdout is blank. Any failure (no argv, spawn
/// error, timeout, unparsable output) yields `AccountIdentity::default()`,
/// i.e. "unknown", which changes nothing (Decision 12).
pub async fn run_identity(plugin: &dyn AgentPlugin, acct: &ResolvedAccount) -> AccountIdentity {
    let Some(argv) = plugin.account_identity_command(acct) else {
        return AccountIdentity::default();
    };
    let Some((command, rest)) = argv.split_first() else {
        return AccountIdentity::default();
    };
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(rest)
        .envs(plugin.account_env(acct))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Inherited tokens must not authenticate a named folder (Decision 9).
    for name in plugin.account_env_unset(acct) {
        cmd.env_remove(name);
    }
    let Ok(mut child) = cmd.spawn() else {
        return AccountIdentity::default();
    };

    let collected = async {
        let (stdout, stderr) = tokio::join!(
            read_capped(child.stdout.take()),
            read_capped(child.stderr.take())
        );
        let exit_ok = child.wait().await.is_ok_and(|s| s.success());
        (stdout, stderr, exit_ok)
    };

    match tokio::time::timeout(IDENTITY_TIMEOUT, collected).await {
        Ok((stdout, stderr, exit_ok)) => {
            let stdout = String::from_utf8_lossy(&stdout);
            let text = if stdout.trim().is_empty() {
                String::from_utf8_lossy(&stderr)
            } else {
                stdout
            };
            plugin.parse_account_identity(&text, exit_ok)
        }
        Err(_) => AccountIdentity::default(),
    }
}

/// Read a child pipe up to [`IDENTITY_MAX_STDOUT`]; `take` stops at the cap and
/// dropping the pipe then closes it, so a chatty command cannot grow the buffer.
async fn read_capped<R: tokio::io::AsyncRead + Unpin>(pipe: Option<R>) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Some(pipe) = pipe {
        let _ = pipe.take(IDENTITY_MAX_STDOUT).read_to_end(&mut buf).await;
    }
    buf
}
#[cfg(test)]
mod tests;
