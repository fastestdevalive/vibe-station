//! The account-switch hand-over table and the replacement plan
//! (multi-account plan A3.8, Decision 7).
//!
//! Pure decision logic: which hand-over the plugin's answer, the source
//! account's resolvability, the channel and an explicit `carryOver` imply; what
//! carry/break kind that produces; and how the replacement record is stamped.
//! The planner that fills this struct lives in `switch.rs`.

use std::path::PathBuf;

use vst_accounts::handover;
use vst_types::rest::sessions::{AccountSwitchHandover, AccountSwitchInfo};
use vst_types::{
    AccountHandover, CarryOver, Channel, FileTransfer, SessionBreakKind, SessionRecord,
};

use crate::sessions::ResetError;

/// What an account switch can do with the model's own context (Decision 7).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Handover {
    /// Copy/hard-link these files into the target account folder, then resume
    /// with the same native chat id.
    Native(Vec<FileTransfer>),
    /// The native store is account-independent; nothing to copy.
    NativeInPlace,
    /// Rich Chat rows are exported as Markdown; the model starts empty.
    Transcript,
    /// Nothing carried.
    Fresh,
}

impl Handover {
    /// Whether the model keeps its own context (native id resume).
    #[must_use]
    pub fn is_native(&self) -> bool {
        matches!(self, Handover::Native(_) | Handover::NativeInPlace)
    }

    fn wire(&self) -> AccountSwitchHandover {
        match self {
            Handover::Native(_) | Handover::NativeInPlace => AccountSwitchHandover::Native,
            Handover::Transcript => AccountSwitchHandover::Transcript,
            Handover::Fresh => AccountSwitchHandover::Fresh,
        }
    }
}

/// The hand-over table of Decision 7, pure and unit-tested.
#[must_use]
pub fn choose_handover(
    plugin_says: AccountHandover,
    from_resolvable: bool,
    channel: Channel,
    has_chat_id: bool,
    cli_changed: bool,
    requested: Option<CarryOver>,
) -> Handover {
    let plugin_says = if cli_changed {
        AccountHandover::Unsupported
    } else {
        plugin_says
    };
    match (requested, plugin_says, from_resolvable, has_chat_id) {
        // Explicit "nothing" is honoured; an explicit summary runs the existing
        // summary path, which copies no native files.
        (Some(CarryOver::Nothing | CarryOver::Summary), ..) => Handover::Fresh,
        // An explicit transcript on Rich Chat skips the native files (the way
        // forward when they cannot be handed over).
        (Some(CarryOver::Transcript), ..) if channel == Channel::Json => Handover::Transcript,
        (_, AccountHandover::Files(files), true, true) => Handover::Native(files),
        (_, AccountHandover::InPlace, _, true) => Handover::NativeInPlace,
        _ if channel == Channel::Json => Handover::Transcript,
        _ => Handover::Fresh,
    }
}

/// The replacement plan `reset_session` applies (Decision 7). `carry_over()`
/// and `break_kind()` are `None` unless the caller sent `accountId`; without it
/// the plan only decides the replacement's account id (N1 rule).
#[derive(Clone, Debug)]
pub struct AccountSwitchPlan {
    pub(crate) explicit: bool,
    pub(crate) from: Option<String>,
    pub(crate) to: Option<String>,
    pub(crate) handover: Handover,
    pub(crate) from_root: Option<PathBuf>,
    pub(crate) to_root: Option<PathBuf>,
    pub(crate) old_chat_id: Option<String>,
    pub(crate) old_acp_id: Option<String>,
    pub(crate) from_display: Option<String>,
    pub(crate) to_display: Option<String>,
    /// The carry this explicit switch applies; `None` when the caller sent no
    /// `accountId` (the existing carry logic decides).
    pub(crate) carry: Option<CarryOver>,
}

impl AccountSwitchPlan {
    /// The carry to apply when this is an explicit switch, else `None` (the
    /// existing carry logic stays untouched). DERIVED from the hand-over, with
    /// an explicit `carryOver: summary` as the one override (Decision 7).
    #[must_use]
    pub fn carry_over(&self) -> Option<CarryOver> {
        self.carry
    }

    /// `switch` when the caller sent `accountId`; else `None` (the existing
    /// mode-change logic decides).
    #[must_use]
    pub fn break_kind(&self) -> Option<SessionBreakKind> {
        self.explicit.then_some(SessionBreakKind::Switch)
    }

    /// Whether this is an explicit account switch.
    #[must_use]
    pub fn is_account_switch(&self) -> bool {
        self.explicit
    }

    /// The account id the replacement runs under (`None` = System login).
    #[must_use]
    pub fn target_account(&self) -> Option<String> {
        self.to.clone()
    }

    /// Whether the model keeps its own context through the CLI's native resume.
    #[must_use]
    pub fn handover_is_native(&self) -> bool {
        self.handover.is_native()
    }

    /// `(from display name, to display name)` for the break marker; empty
    /// unless this is an explicit account switch.
    #[must_use]
    pub fn marker_accounts(&self) -> (Option<String>, Option<String>) {
        if !self.explicit {
            return (None, None);
        }
        (self.from_display.clone(), self.to_display.clone())
    }

    /// Stamp the replacement record: its account, and for a native hand-over
    /// the ids the CLI needs to resume the copied conversation.
    pub fn finish_record(&self, record: &mut SessionRecord) {
        record.account_id.clone_from(&self.to);
        // Only an EXPLICIT switch hands the native conversation over; a normal
        // reset must keep starting a fresh conversation.
        if self.explicit && self.handover.is_native() {
            record.agent_chat_id.clone_from(&self.old_chat_id);
            record.acp_session_id.clone_from(&self.old_acp_id);
        }
    }

    /// Copy the hand-over files. Runs after `prepare_carry` and before the
    /// point of no return: a failure leaves the old session intact.
    ///
    /// # Errors
    ///
    /// [`ResetError::HandoverFailed`] (409 `handover_failed`) for a refused or
    /// failed transfer.
    pub fn apply_transfers(&self) -> Result<(), ResetError> {
        if !self.explicit {
            return Ok(());
        }
        let Handover::Native(files) = &self.handover else {
            return Ok(());
        };
        if files.is_empty() {
            return Ok(());
        }
        let (Some(from_root), Some(to_root)) = (&self.from_root, &self.to_root) else {
            return Err(ResetError::HandoverFailed(
                "The account folder for the hand-over is unknown.".to_string(),
            ));
        };
        handover::apply(files, from_root, to_root)
            .map(|_| ())
            .map_err(|e| match e {
                handover::HandoverError::WouldClobber(_) => ResetError::HandoverFailed(
                    "This chat was continued in both accounts, so the two copies differ and cannot be handed over. Nothing changed."
                        .to_string(),
                ),
                e => ResetError::HandoverFailed(format!(
                    "Could not hand over the conversation: {e}"
                )),
            })
    }

    /// `accountSwitch` for the response; present only for an explicit switch.
    #[must_use]
    pub fn result(&self) -> Option<AccountSwitchInfo> {
        self.explicit.then(|| AccountSwitchInfo {
            from_account_id: self.from.clone(),
            to_account_id: self.to.clone(),
            handover: self.handover.wire(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vst_types::TransferMode;

    fn files() -> AccountHandover {
        AccountHandover::Files(vec![FileTransfer {
            from: PathBuf::from("/a/x.jsonl"),
            to: PathBuf::from("/b/x.jsonl"),
            mode: TransferMode::Copy,
        }])
    }
    #[test]
    fn choose_handover_honours_requested_nothing_and_summary() {
        assert_eq!(
            choose_handover(
                files(),
                true,
                Channel::Json,
                true,
                false,
                Some(CarryOver::Nothing)
            ),
            Handover::Fresh
        );
        assert_eq!(
            choose_handover(
                files(),
                true,
                Channel::Json,
                true,
                false,
                Some(CarryOver::Summary)
            ),
            Handover::Fresh
        );
    }

    #[test]
    fn choose_handover_explicit_transcript_on_rich_chat() {
        assert_eq!(
            choose_handover(
                files(),
                true,
                Channel::Json,
                true,
                false,
                Some(CarryOver::Transcript)
            ),
            Handover::Transcript
        );
        assert!(matches!(
            choose_handover(
                files(),
                true,
                Channel::Tmux,
                true,
                false,
                Some(CarryOver::Transcript)
            ),
            Handover::Native(_)
        ));
        assert!(matches!(
            choose_handover(files(), true, Channel::Json, true, false, None),
            Handover::Native(_)
        ));
    }

    #[test]
    fn apply_transfers_diverged_copies_explain_without_a_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("from")).unwrap();
        std::fs::create_dir_all(dir.path().join("to")).unwrap();
        let from = dir.path().join("from").join("chat.jsonl");
        std::fs::write(&from, "left\n").unwrap();
        let to = dir.path().join("to").join("chat.jsonl");
        std::fs::write(&to, "right\n").unwrap();
        let plan = native_plan(
            dir.path(),
            FileTransfer {
                from,
                to,
                mode: TransferMode::Copy,
            },
        );
        match plan.apply_transfers() {
            Err(ResetError::HandoverFailed(m)) => {
                assert!(m.starts_with("This chat was continued in both accounts"));
                assert!(!m.contains('/'), "no path in the text: {m}");
            }
            other => panic!("expected HandoverFailed, got {other:?}"),
        }
    }

    #[test]
    fn choose_handover_native_requires_a_resolvable_source_and_a_chat_id() {
        assert!(matches!(
            choose_handover(files(), true, Channel::Json, true, false, None),
            Handover::Native(_)
        ));
        assert_eq!(
            choose_handover(files(), false, Channel::Json, true, false, None),
            Handover::Transcript
        );
        assert_eq!(
            choose_handover(files(), true, Channel::Json, false, false, None),
            Handover::Transcript
        );
        assert_eq!(
            choose_handover(files(), true, Channel::Tmux, false, false, None),
            Handover::Fresh
        );
    }

    #[test]
    fn choose_handover_never_native_when_the_cli_changed() {
        assert_eq!(
            choose_handover(files(), true, Channel::Json, true, true, None),
            Handover::Transcript
        );
        assert_eq!(
            choose_handover(
                AccountHandover::InPlace,
                true,
                Channel::Json,
                true,
                true,
                None
            ),
            Handover::Transcript
        );
        assert_eq!(
            choose_handover(
                AccountHandover::InPlace,
                true,
                Channel::Tmux,
                true,
                true,
                None
            ),
            Handover::Fresh
        );
    }
    /// The plan for a Native hand-over over `dir` (from → to).
    fn native_plan(dir: &std::path::Path, transfer: FileTransfer) -> AccountSwitchPlan {
        AccountSwitchPlan {
            explicit: true,
            from: Some("acc_from".to_string()),
            to: Some("acc_to".to_string()),
            handover: Handover::Native(vec![transfer]),
            from_root: Some(dir.join("from")),
            to_root: Some(dir.join("to")),
            old_chat_id: None,
            old_acp_id: None,
            from_display: None,
            to_display: None,
            carry: Some(CarryOver::Native),
        }
    }

    #[test]
    fn apply_transfers_copies_inside_the_roots() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("from")).unwrap();
        std::fs::create_dir_all(dir.path().join("to")).unwrap();
        let from = dir.path().join("from").join("chat.jsonl");
        std::fs::write(&from, "conversation").unwrap();
        let to = dir.path().join("to").join("chat.jsonl");
        let plan = native_plan(
            dir.path(),
            FileTransfer {
                from: from.clone(),
                to: to.clone(),
                mode: TransferMode::Copy,
            },
        );
        plan.apply_transfers().expect("copy inside the roots");
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "conversation");
    }

    #[test]
    fn apply_transfers_returns_to_the_first_account() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("from")).unwrap();
        std::fs::create_dir_all(dir.path().join("to")).unwrap();
        let from = dir.path().join("from").join("chat.jsonl");
        std::fs::write(&from, "a\nb\nc\n").unwrap();
        let to = dir.path().join("to").join("chat.jsonl");
        std::fs::write(&to, "a\nb\n").unwrap();
        let plan = native_plan(
            dir.path(),
            FileTransfer {
                from,
                to: to.clone(),
                mode: TransferMode::Copy,
            },
        );
        plan.apply_transfers().expect("an earlier copy is replaced");
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "a\nb\nc\n");
    }

    /// A refused transfer aborts the switch BEFORE the point of no return, so
    /// the old session is intact (Risk 12 / `handover_failed`).
    #[test]
    fn apply_transfers_refuses_a_path_outside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("from")).unwrap();
        std::fs::create_dir_all(dir.path().join("to")).unwrap();
        let outside = dir.path().join("outside.jsonl");
        std::fs::write(&outside, "not this account's file").unwrap();
        let plan = native_plan(
            dir.path(),
            FileTransfer {
                from: outside,
                to: dir.path().join("to").join("chat.jsonl"),
                mode: TransferMode::Copy,
            },
        );
        assert!(matches!(
            plan.apply_transfers(),
            Err(ResetError::HandoverFailed(_))
        ));
        assert!(
            !dir.path().join("to").join("chat.jsonl").exists(),
            "nothing is copied on a refused transfer"
        );
    }
    #[test]
    fn choose_handover_in_place_is_native_with_a_chat_id() {
        assert_eq!(
            choose_handover(
                AccountHandover::InPlace,
                true,
                Channel::Json,
                true,
                false,
                None
            ),
            Handover::NativeInPlace
        );
        assert_eq!(
            choose_handover(
                AccountHandover::InPlace,
                false,
                Channel::Json,
                true,
                false,
                None
            ),
            Handover::NativeInPlace
        );
    }
}
