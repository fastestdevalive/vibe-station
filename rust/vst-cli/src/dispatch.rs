//! argv0 / subcommand dispatch for the merged `vst` binary.
//!
//! `vst`'s `main()` calls `resolve_entry_mode` before doing any of its normal
//! CLI argument parsing (`program::parse_args`). If the result is
//! `EntryMode::Daemon`, `main()` calls `vst_daemon::run_daemon` directly and
//! never reaches `parse_args` at all. See the `cli-daemon-unification`
//! feature plan (Part 00) for why this exists.

/// What this process invocation should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryMode {
    /// Run the daemon. `headless` mirrors `vst_daemon::DaemonOptions::headless`.
    Daemon { headless: bool },
    /// Run as the ordinary CLI (`program::parse_args` + dispatch).
    Cli,
}

/// Decide whether this invocation should run as the daemon or the CLI.
///
/// Two ways to trigger daemon mode:
/// - argv0's file stem is exactly `vst-daemon` (a symlink/copy named that way).
/// - `args` (i.e. everything after argv0) starts with `["daemon", "run"]`.
///
/// Headless defaults to `true`; the only way to get `false` is
/// `VST_TAURI_SUPERVISED` set to exactly `"1"` or `"true"` in the
/// environment — set exclusively by Tauri's own sidecar-spawn code
/// (`desktop/src-tauri/src/daemon.rs`). Any other value (including `"0"`)
/// or an unset var means headless — see the feature PRD's Key Decision on
/// headless-mode detection for why this is a strict allowlist, not a
/// truthy/falsy read.
pub fn resolve_entry_mode(argv0: &str, args: &[String]) -> EntryMode {
    let argv0_is_daemon = std::path::Path::new(argv0)
        .file_stem()
        .and_then(|s| s.to_str())
        == Some("vst-daemon");
    let is_daemon_run = args.first().map(String::as_str) == Some("daemon")
        && args.get(1).map(String::as_str) == Some("run");

    if argv0_is_daemon || is_daemon_run {
        let supervised = matches!(
            std::env::var("VST_TAURI_SUPERVISED").as_deref(),
            Ok("1") | Ok("true")
        );
        EntryMode::Daemon {
            headless: !supervised,
        }
    } else {
        EntryMode::Cli
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // `cargo test` runs a crate's unit tests in parallel threads within one
    // process — std::env mutation is process-global, so any two of these
    // tests running concurrently race on VST_TAURI_SUPERVISED (confirmed:
    // this raced and failed intermittently before this mutex was added).
    // Every test that reads/writes the var takes this lock for its duration.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn daemon_run_subcommand_triggers_daemon_mode_headless_by_default() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("VST_TAURI_SUPERVISED");
        assert_eq!(
            resolve_entry_mode("vst", &args(&["daemon", "run"])),
            EntryMode::Daemon { headless: true }
        );
    }

    #[test]
    fn argv0_vst_daemon_triggers_daemon_mode() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("VST_TAURI_SUPERVISED");
        assert_eq!(
            resolve_entry_mode("/usr/local/bin/vst-daemon", &args(&[])),
            EntryMode::Daemon { headless: true }
        );
    }

    #[test]
    fn supervised_flag_disables_headless() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("VST_TAURI_SUPERVISED", "1");
        let result = resolve_entry_mode("vst", &args(&["daemon", "run"]));
        std::env::remove_var("VST_TAURI_SUPERVISED");
        assert_eq!(result, EntryMode::Daemon { headless: false });
    }

    #[test]
    fn supervised_flag_requires_exact_match() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("VST_TAURI_SUPERVISED", "0");
        let result = resolve_entry_mode("vst", &args(&["daemon", "run"]));
        std::env::remove_var("VST_TAURI_SUPERVISED");
        assert_eq!(result, EntryMode::Daemon { headless: true });
    }

    #[test]
    fn ordinary_commands_are_cli_mode() {
        assert_eq!(
            resolve_entry_mode("vst", &args(&["agent", "ls"])),
            EntryMode::Cli
        );
        assert_eq!(
            resolve_entry_mode("vst", &args(&["daemon", "status"])),
            EntryMode::Cli
        );
        assert_eq!(resolve_entry_mode("vst", &args(&[])), EntryMode::Cli);
    }
}
