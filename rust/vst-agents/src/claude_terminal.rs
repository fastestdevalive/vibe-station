//! Claude Code's Terminal readiness probe.
//!
//! The rule is evidenced by the pane fixtures under
//! `tests/fixtures/terminal_panes/claude/` (spike C1) and works on the VISIBLE
//! screen plus the cursor position, never on scrollback:
//!
//! - **Ready**: the cursor is on a prompt line (`❯`) at column 2 (empty input;
//!   a grey placeholder or suggestion does not move the cursor, typed text
//!   does), that line sits in a complete rule box (a `─` rule above and a rule
//!   of the same width below, so a half-drawn screen does not count), and
//!   nothing above the box looks busy (a spinner line such as
//!   `· Deliberating…`, or `esc to interrupt` near the bottom).
//! - **AwaitingApproval**: a dialog line is present in the LIVE region, the
//!   rows from the last full-width rule down (`Do you want to proceed?`,
//!   `Esc to cancel`, `Enter to confirm`, `Quick safety check`, or a numbered
//!   `❯ 1.` choice). Transcript rows above that rule (a user message such as
//!   `❯ 1. fix the parser`) never match. A screen with no rule at all (a bare
//!   startup dialog) is searched whole.
//! - everything else (starting, working, text typed or a collapsed paste still in
//!   the box) is `Unknown`.

use vst_types::{PaneSnapshot, TerminalReadiness};

/// Cursor column of an empty prompt: `❯` plus one space.
const EMPTY_PROMPT_X: u16 = 2;
/// How many lines above the input box are searched for a spinner.
const SPINNER_WINDOW: usize = 8;

pub fn readiness(pane: &PaneSnapshot) -> TerminalReadiness {
    let lines: Vec<&str> = pane.text.lines().collect();
    if has_dialog(&lines) {
        return TerminalReadiness::AwaitingApproval;
    }
    let y = usize::from(pane.cursor_y);
    if pane.cursor_x != EMPTY_PROMPT_X || y == 0 || y + 1 >= lines.len() {
        return TerminalReadiness::Unknown;
    }
    if !lines[y].starts_with('❯') {
        return TerminalReadiness::Unknown;
    }
    let (top, bottom) = (rule_len(lines[y - 1]), rule_len(lines[y + 1]));
    if top == 0 || bottom != top {
        return TerminalReadiness::Unknown;
    }
    if looks_busy(&lines, y - 1, y + 2) {
        return TerminalReadiness::Unknown;
    }
    TerminalReadiness::Ready
}

/// Number of leading `─` characters, 0 when the line is not a rule.
fn rule_len(line: &str) -> usize {
    line.chars().take_while(|c| *c == '─').count()
}

/// The rows from the last full-width rule down: the input box and its footer,
/// or the dialog that replaced the box. The whole screen when no rule is drawn.
fn live_region<'a>(lines: &'a [&'a str]) -> &'a [&'a str] {
    match lines.iter().rposition(|l| rule_len(l) > 0) {
        Some(i) => &lines[i..],
        None => lines,
    }
}

/// Dialogs are searched in the live region only, so transcript text that
/// merely looks like a dialog cannot hold a delivery in `AwaitingApproval`.
fn has_dialog(lines: &[&str]) -> bool {
    live_region(lines).iter().any(|l| {
        let t = l.trim();
        t == "Do you want to proceed?"
            || t.starts_with("Esc to cancel")
            || t.starts_with("Enter to confirm")
            || t.starts_with("Quick safety check")
            || t.starts_with("❯ 1.")
    })
}

/// A spinner line directly above the box, or the `esc to interrupt` footer
/// (only the rows below the box's bottom rule, never transcript text).
fn looks_busy(lines: &[&str], top_rule: usize, footer_start: usize) -> bool {
    if lines[footer_start.min(lines.len())..]
        .iter()
        .any(|l| l.to_lowercase().contains("esc to interrupt"))
    {
        return true;
    }
    lines[top_rule.saturating_sub(SPINNER_WINDOW)..top_rule]
        .iter()
        .any(|l| is_spinner_line(l))
}

/// `<symbol> <Word>…` such as `· Deliberating…` or `✽ Nebulizing… (1s · ↓ 1 tokens)`.
fn is_spinner_line(line: &str) -> bool {
    let mut chars = line.trim_end().chars();
    let Some(symbol) = chars.next() else {
        return false;
    };
    if symbol.is_whitespace() || !chars.next().is_some_and(char::is_whitespace) {
        return false;
    }
    chars
        .as_str()
        .split_whitespace()
        .next()
        .is_some_and(|word| word.contains('…'))
}
