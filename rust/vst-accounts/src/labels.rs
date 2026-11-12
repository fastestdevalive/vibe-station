//! Labels: the user-facing name of an account.
//!
//! A label is optional, trimmed, 1..=40 chars, free of control characters and
//! unique per CLI case-insensitively (the System row's effective name counts
//! too). Display name = label, else email, else id; the System login is
//! "System login" unless renamed (`docs/MULTI-ACCOUNT.md` rule 10).

/// The System row's default display name.
pub const SYSTEM_LOGIN_NAME: &str = "System login";

/// Longest accepted label, in chars.
pub const MAX_LABEL_CHARS: usize = 40;

/// Why a label was rejected.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum LabelError {
    #[error("a name is required")]
    Empty,
    #[error("a name can be at most 40 characters")]
    TooLong,
    #[error("a name cannot contain control characters")]
    Control,
}

/// Trim and validate a label: 1..=40 chars, no control characters.
///
/// # Errors
///
/// [`LabelError::Empty`], [`LabelError::TooLong`] or [`LabelError::Control`].
pub fn normalize_label(raw: &str) -> Result<String, LabelError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(LabelError::Empty);
    }
    if trimmed.chars().any(char::is_control) {
        return Err(LabelError::Control);
    }
    if trimmed.chars().count() > MAX_LABEL_CHARS {
        return Err(LabelError::TooLong);
    }
    Ok(trimmed.to_string())
}

/// What the UI shows for an account.
#[must_use]
pub fn display_name(label: Option<&str>, email: Option<&str>, id: &str, is_system: bool) -> String {
    if let Some(label) = label.filter(|l| !l.trim().is_empty()) {
        return label.trim().to_string();
    }
    if let Some(email) = email.filter(|e| !e.trim().is_empty()) {
        return email.trim().to_string();
    }
    if is_system {
        SYSTEM_LOGIN_NAME.to_string()
    } else {
        id.to_string()
    }
}

/// One row considered by the uniqueness check: `(cli, id, effective name)`.
pub type LabelRow<'a> = (&'a str, &'a str, &'a str);

/// Whether `label` is already the effective name of another account of `cli`
/// (case-insensitive). `except_id` excludes the row being renamed.
#[must_use]
pub fn label_taken(rows: &[LabelRow<'_>], cli: &str, label: &str, except_id: Option<&str>) -> bool {
    let wanted = label.trim().to_lowercase();
    rows.iter().any(|(row_cli, row_id, name)| {
        *row_cli == cli && Some(*row_id) != except_id && name.trim().to_lowercase() == wanted
    })
}
