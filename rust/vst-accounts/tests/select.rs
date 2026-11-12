//! `select_account` precedence tests (Decision 11).

mod common;

use vst_accounts::select::{select_account, AccountView, SelectError};

use common::CLI;

struct FakeView {
    /// `(cli, id, label)` rows.
    rows: Vec<(&'static str, &'static str, Option<&'static str>)>,
    default: Option<&'static str>,
}

impl AccountView for FakeView {
    fn exists(&self, cli: &str, account_id: &str) -> bool {
        self.rows
            .iter()
            .any(|(c, id, _)| *c == cli && *id == account_id)
    }
    fn id_for_label(&self, cli: &str, label: &str) -> Option<String> {
        self.rows
            .iter()
            .find(|(c, _, l)| *c == cli && l.is_some_and(|l| l.eq_ignore_ascii_case(label)))
            .map(|(_, id, _)| (*id).to_string())
    }
    fn default_for(&self, cli: &str) -> Option<String> {
        self.default
            .map(str::to_string)
            .filter(|_| self.rows.iter().any(|(c, _, _)| *c == cli))
    }
}

fn view() -> FakeView {
    FakeView {
        rows: vec![
            (CLI, "acc_11111111", Some("Work")),
            (CLI, "acc_22222222", Some("Home")),
            ("othercli", "acc_33333333", Some("Other")),
        ],
        default: Some("acc_22222222"),
    }
}

#[test]
fn select_account_precedence() {
    let v = view();
    // Explicit id wins over everything.
    assert_eq!(
        select_account(&v, CLI, Some("acc_11111111"), Some((CLI, "acc_22222222"))),
        Ok(Some("acc_11111111".to_string()))
    );
    // Explicit label resolves case-insensitively.
    assert_eq!(
        select_account(&v, CLI, Some("home"), None),
        Ok(Some("acc_22222222".to_string()))
    );
    // Explicit "system" means the System login.
    assert_eq!(select_account(&v, CLI, Some("system"), None), Ok(None));
    // An unknown explicit pick is an error, never a silent default.
    assert_eq!(
        select_account(&v, CLI, Some("acc_missing"), None),
        Err(SelectError::UnknownExplicit)
    );
    // Parent wins over the default when it belongs to the same CLI.
    assert_eq!(
        select_account(&v, CLI, None, Some((CLI, "acc_11111111"))),
        Ok(Some("acc_11111111".to_string()))
    );
    // A parent of another CLI is ignored.
    assert_eq!(
        select_account(&v, CLI, None, Some(("othercli", "acc_33333333"))),
        Ok(Some("acc_22222222".to_string()))
    );
    // An unknown parent id is ignored too.
    assert_eq!(
        select_account(&v, CLI, None, Some((CLI, "acc_missing"))),
        Ok(Some("acc_22222222".to_string()))
    );
    // No explicit pick, no parent -> the CLI default.
    assert_eq!(
        select_account(&v, CLI, None, None),
        Ok(Some("acc_22222222".to_string()))
    );
    // No default -> the System login.
    let no_default = FakeView {
        default: None,
        ..view()
    };
    assert_eq!(select_account(&no_default, CLI, None, None), Ok(None));
    // An empty explicit string is treated as absent.
    assert_eq!(
        select_account(&v, CLI, Some("  "), None),
        Ok(Some("acc_22222222".to_string()))
    );
}
