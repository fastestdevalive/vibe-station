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
    /// Run the daemon.
    Daemon,
    /// Run as the ordinary CLI (`program::parse_args` + dispatch).
    Cli,
}

/// Decide whether this invocation should run as the daemon or the CLI.
///
/// Two ways to trigger daemon mode:
/// - argv0's file stem is exactly `vst-daemon` (a symlink/copy named that way).
/// - `args` (i.e. everything after argv0) starts with `["daemon", "run"]`.
pub fn resolve_entry_mode(argv0: &str, args: &[String]) -> EntryMode {
    let argv0_is_daemon = std::path::Path::new(argv0)
        .file_stem()
        .and_then(|s| s.to_str())
        == Some("vst-daemon");
    let is_daemon_run = args.first().map(String::as_str) == Some("daemon")
        && args.get(1).map(String::as_str) == Some("run");

    if argv0_is_daemon || is_daemon_run {
        EntryMode::Daemon
    } else {
        EntryMode::Cli
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn daemon_run_subcommand_triggers_daemon_mode() {
        assert_eq!(
            resolve_entry_mode("vst", &args(&["daemon", "run"])),
            EntryMode::Daemon
        );
    }

    #[test]
    fn argv0_vst_daemon_triggers_daemon_mode() {
        assert_eq!(
            resolve_entry_mode("/usr/local/bin/vst-daemon", &args(&[])),
            EntryMode::Daemon
        );
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
