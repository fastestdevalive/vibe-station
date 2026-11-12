//! agy's account facts (R1) — the one harness that ships WITHOUT accounts.
//!
//! Spike fact V9 (`docs/MULTI-ACCOUNT.md`): agy has no dedicated config/data/
//! state directory env var; its data dir comes from an internal
//! `--app_data_dir=` flag and both its log path and its limits probe resolve
//! from the whole home directory. Shadowing `HOME=<account dir>` would hide
//! `~/.ssh`, `~/.gitconfig` and the toolchains from the agent, so multiple agy
//! accounts are not supported (Decision 12/A8) — the plan's only allowed
//! shortfall.

/// Why agy ships without accounts. Shown in Settings when
/// `GET /api/supported-clis` reports `supportsAccounts: false`.
pub const UNSUPPORTED_REASON: &str = "agy keeps its login under the whole home directory; a separate login would hide your ssh and git setup from the agent, so multiple agy accounts are not supported yet.";

/// The Settings note for agy.
#[must_use]
pub fn accounts_unsupported_reason() -> Option<&'static str> {
    Some(UNSUPPORTED_REASON)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reason_is_non_empty_and_explains_the_home() {
        let reason = accounts_unsupported_reason().expect("agy must explain itself");
        assert!(reason.contains("home directory"), "{reason}");
    }
}
