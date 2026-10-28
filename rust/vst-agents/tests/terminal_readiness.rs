//! Terminal readiness probes against the pane fixtures captured in spike C1
//! (`tests/fixtures/terminal_panes/<cli>/<state>.txt` + `<state>.cursor`).

use std::fs;
use std::path::PathBuf;

use vst_agents::registry::resolve_plugin;
use vst_types::{CliId, PaneSnapshot, TerminalReadiness};

/// (state, cursor fallback when the capture has no sidecar, expected readiness)
type Case = (&'static str, Option<(u16, u16)>, TerminalReadiness);

fn dir(cli: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/terminal_panes")
        .join(cli)
}

/// Load a fixture. A `<state>.cursor` sidecar holds `cursor_x cursor_y`; where
/// none was captured the caller's `fallback` is used.
fn load(cli: &str, state: &str, fallback: Option<(u16, u16)>) -> PaneSnapshot {
    let text = fs::read_to_string(dir(cli).join(format!("{state}.txt"))).unwrap();
    let (cursor_x, cursor_y) = match fs::read_to_string(dir(cli).join(format!("{state}.cursor"))) {
        Ok(s) => {
            let mut it = s.split_whitespace().map(|n| n.parse::<u16>().unwrap());
            (it.next().unwrap(), it.next().unwrap())
        }
        Err(_) => fallback.unwrap_or_else(|| panic!("{cli}/{state} has no cursor sidecar")),
    };
    PaneSnapshot {
        text,
        cursor_x,
        cursor_y,
    }
}

#[test]
fn claude_probe_matches_every_fixture() {
    use TerminalReadiness::*;
    let p = resolve_plugin(CliId::Claude);
    // `ready-empty-prompt` and `ready-after-turn` were captured without a
    // sidecar; both show an empty prompt on screen row 42 (the spike measured
    // x=2 for every empty prompt). `starting` is a half-drawn first frame.
    let table: &[Case] = &[
        ("ready-empty-prompt", Some((2, 42)), Ready),
        ("ready-empty-prompt-2", None, Ready),
        ("ready-after-turn", Some((2, 42)), Ready),
        ("ready-ghost-suggestion", None, Ready),
        ("after-approval-denied", None, Ready),
        ("starting", Some((2, 42)), Unknown),
        ("typed-text", None, Unknown),
        ("working", None, Unknown),
        ("working-typed-text", None, Unknown),
        ("pasted-collapsed", None, Unknown),
        ("approval-permission", None, AwaitingApproval),
        ("approval-trust-folder", Some((0, 0)), AwaitingApproval),
        ("approval-chrome-extension", Some((0, 0)), AwaitingApproval),
    ];
    for (state, cursor, want) in table {
        let pane = load("claude", state, *cursor);
        assert_eq!(p.terminal_readiness(&pane), *want, "claude/{state}");
    }
    // Every captured claude fixture is covered by the table.
    let mut on_disk: Vec<String> = fs::read_dir(dir("claude"))
        .unwrap()
        .filter_map(|e| {
            let n = e.unwrap().file_name().into_string().unwrap();
            n.strip_suffix(".txt").map(str::to_string)
        })
        .collect();
    on_disk.sort();
    let mut covered: Vec<String> = table.iter().map(|(s, _, _)| s.to_string()).collect();
    covered.sort();
    assert_eq!(on_disk, covered);
}

#[test]
fn claude_probe_needs_the_cursor_on_an_empty_prompt() {
    let p = resolve_plugin(CliId::Claude);
    let mut pane = load("claude", "ready-empty-prompt-2", None);
    assert_eq!(p.terminal_readiness(&pane), TerminalReadiness::Ready);
    pane.cursor_x = 13; // text typed at the prompt
    assert_eq!(p.terminal_readiness(&pane), TerminalReadiness::Unknown);
    pane.cursor_x = 2;
    pane.cursor_y = 5; // cursor not on the prompt line
    assert_eq!(p.terminal_readiness(&pane), TerminalReadiness::Unknown);
    pane.cursor_y = 9999; // out of range never panics
    assert_eq!(p.terminal_readiness(&pane), TerminalReadiness::Unknown);
}

#[test]
fn claude_probe_footer_alone_is_busy() {
    let p = resolve_plugin(CliId::Claude);
    let mut pane = load("claude", "ready-empty-prompt-2", None);
    pane.text.push_str("\n  esc to interrupt");
    assert_eq!(p.terminal_readiness(&pane), TerminalReadiness::Unknown);
}

/// Replace screen row `row` (0-based) of `pane`.
fn with_row(pane: &mut PaneSnapshot, row: usize, new: &str) {
    let mut lines: Vec<String> = pane.text.lines().map(str::to_string).collect();
    lines[row] = new.to_string();
    pane.text = lines.join("\n");
}

#[test]
fn claude_probe_ignores_transcript_lines_that_look_like_a_dialog_or_the_busy_footer() {
    let p = resolve_plugin(CliId::Claude);
    // A user message "1. fix the parser" is drawn in the transcript as `❯ 1. ...`.
    let mut pane = load("claude", "ready-empty-prompt-2", None);
    with_row(&mut pane, 26, "❯ 1. fix the parser");
    assert_eq!(p.terminal_readiness(&pane), TerminalReadiness::Ready);
    // So can any transcript row quoting a dialog phrase.
    with_row(&mut pane, 26, "Do you want to proceed?");
    assert_eq!(p.terminal_readiness(&pane), TerminalReadiness::Ready);
    // `esc to interrupt` in the transcript (above the box) is not the footer.
    let mut pane = load("claude", "ready-empty-prompt-2", None);
    with_row(&mut pane, 28, "  esc to interrupt");
    assert_eq!(p.terminal_readiness(&pane), TerminalReadiness::Ready);
    // A real dialog still wins even with such a transcript row above it.
    let mut pane = load("claude", "approval-permission", None);
    with_row(&mut pane, 26, "❯ 1. fix the parser");
    assert_eq!(
        p.terminal_readiness(&pane),
        TerminalReadiness::AwaitingApproval
    );
}

#[test]
fn claude_terminal_delivery_caps_match_the_spike() {
    let caps = resolve_plugin(CliId::Claude).terminal_delivery().unwrap();
    assert_eq!(caps.settle_ms, 200);
    assert!(caps.multiline_ok);
    assert!(!caps.raw_lf);
}

#[test]
fn every_other_plugin_is_unsupported_and_never_ready() {
    for cli in [
        CliId::Cursor,
        CliId::Opencode,
        CliId::Agy,
        CliId::Codex,
        CliId::Pi,
        CliId::Omp,
    ] {
        let p = resolve_plugin(cli);
        assert!(p.terminal_delivery().is_none(), "{cli:?}");
        for sub in ["claude", "codex", "opencode", "pi", "agy"] {
            for e in fs::read_dir(dir(sub)).unwrap() {
                let n = e.unwrap().file_name().into_string().unwrap();
                if let Some(state) = n.strip_suffix(".txt") {
                    let pane = load(sub, state, Some((2, 42)));
                    assert_eq!(
                        p.terminal_readiness(&pane),
                        TerminalReadiness::Unknown,
                        "{cli:?} on {sub}/{state}"
                    );
                }
            }
        }
    }
}

#[test]
fn trait_defaults_are_unsupported_and_unknown() {
    // The defaults live on the trait: check through a plugin that overrides neither.
    let p = resolve_plugin(CliId::Codex);
    assert!(p.terminal_delivery().is_none());
    assert_eq!(
        p.terminal_readiness(&PaneSnapshot::default()),
        TerminalReadiness::Unknown
    );
}
