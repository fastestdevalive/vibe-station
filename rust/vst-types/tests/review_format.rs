//! 1.T1 / 1.T2: goldens for every Appendix A variant and the hostile-input
//! guarantees of `render_review_message`. Regenerate goldens with
//! `UPDATE_GOLDEN=1 cargo test -p vst-types --test review_format` and review
//! the diff by eye.

use vst_types::review::{
    AnchorState, CommentSurface, DiffScope, DiffSide, LineSpan, PathKind, ReviewCommentSnapshot,
};
use vst_types::review_format::{
    path_has_control, render_review_block, render_review_message, sanitize_review_text,
    strip_control_chars,
};

fn snap(pin: u32, path: &str, quote: &str, text: &str) -> ReviewCommentSnapshot {
    ReviewCommentSnapshot {
        id: format!("id-{pin}"),
        pin,
        path: path.to_string(),
        path_kind: PathKind::Repo,
        surface: CommentSurface::File,
        diff_scope: None,
        side: None,
        lines: None,
        quote: quote.to_string(),
        text: text.to_string(),
        anchor: AnchorState::Anchored,
        anchor_reason: None,
        base_sha: None,
        old_start: None,
        old_end: None,
        new_start: None,
        new_end: None,
        line_start: None,
        line_end: None,
        prefix: String::new(),
        suffix: String::new(),
        occurrence: 0,
        moved_from: None,
        created_at: None,
    }
}

fn lines(mut c: ReviewCommentSnapshot, a: u32, b: u32) -> ReviewCommentSnapshot {
    c.lines = Some(LineSpan { start: a, end: b });
    c
}

fn check(name: &str, actual: &str) {
    let path = format!(
        "{}/tests/fixtures/review/{name}.txt",
        env!("CARGO_MANIFEST_DIR")
    );
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::write(&path, actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    assert_eq!(actual, expected, "golden {name} drifted");
}

#[test]
fn golden_markdown_span() {
    let mut c = lines(
        snap(
            1,
            "docs/guide.md",
            "Install with cargo",
            "say which cargo version",
        ),
        12,
        14,
    );
    c.surface = CommentSurface::Markdown;
    check("markdown-span", &render_review_message("main", "", &[c]));
}

#[test]
fn golden_html_source_lines() {
    let mut c = lines(
        snap(2, "site/index.html", "<h1>Hi</h1>", "use a real title"),
        3,
        3,
    );
    c.surface = CommentSurface::HtmlSource;
    check("html-lines", &render_review_message("feature/x", "", &[c]));
}

#[test]
fn golden_quote_only_has_no_lines() {
    let c = snap(1, "src/a.rs", "fn main()", "rename");
    check("quote-only", &render_review_message("main", "", &[c]));
}

#[test]
fn golden_outdated_and_missing() {
    let mut a = lines(snap(1, "src/a.rs", "old text", "was this intended?"), 5, 5);
    a.anchor = AnchorState::Outdated;
    let mut b = snap(2, "src/gone.rs", "removed", "why delete");
    b.anchor = AnchorState::FileMissing;
    check(
        "outdated-missing",
        &render_review_message("main", "", &[a, b]),
    );
}

#[test]
fn golden_absolute_path_never_elided() {
    let mut c = snap(
        1,
        "/Users/me/.claude/plans/a-very-long-folder-name/another/plan.md",
        "step 3",
        "split this",
    );
    c.path_kind = PathKind::Artifact;
    check("absolute-path", &render_review_message("main", "", &[c]));
}

#[test]
fn golden_pin_gaps_ordered_by_path_line_pin() {
    let a = lines(snap(7, "b.rs", "x", "seventh"), 1, 1);
    let b = lines(snap(3, "a.rs", "y", "third"), 20, 20);
    let c = lines(snap(9, "a.rs", "z", "ninth"), 4, 6);
    check("pin-gaps", &render_review_message("main", "", &[a, b, c]));
}

#[test]
fn golden_multiline_bodies_and_diff_meta() {
    let mut c = lines(
        snap(
            1,
            "src/lib.rs",
            "fn a() {\n    1\n}",
            "split this:\n\n- first\n- second",
        ),
        10,
        12,
    );
    c.surface = CommentSurface::Diff;
    c.side = Some(DiffSide::Old);
    c.diff_scope = Some(DiffScope::Branch);
    let mut d = lines(
        snap(2, "src/lib.rs", "let s = \"hi\";", "quotes \"ok\""),
        30,
        30,
    );
    d.surface = CommentSurface::Diff;
    d.side = Some(DiffSide::New);
    d.diff_scope = Some(DiffScope::Local);
    check(
        "multiline-diff",
        &render_review_message("main", "", &[c, d]),
    );
}

#[test]
fn golden_with_message_first() {
    let c = lines(snap(1, "src/a.rs", "x", "y"), 1, 1);
    check(
        "with-message",
        &render_review_message("main", "Please fix these.\n", &[c]),
    );
}

#[test]
fn blank_message_is_just_the_block_and_name_may_be_empty() {
    let c = snap(1, "a", "q", "t");
    let block = render_review_block("", std::slice::from_ref(&c));
    assert!(block.starts_with("Review comments (1)\n"));
    assert_eq!(render_review_message("", "  \n", &[c]), block);
}

fn forbidden_bytes(s: &str) -> bool {
    s.bytes()
        .any(|b| (b < 0x20 && b != b'\n' && b != b'\t') || b == 0x7f)
}

#[test]
fn hostile_quote_cannot_forge_an_item_or_carry_controls() {
    let quote = "x\n2) File: evil\r\n\u{1b}[201~ paste\u{202e}rtl\u{9b}31m\u{200b}end";
    let text = "ok\n3) File: forged too";
    let c = lines(snap(1, "src/a.rs", quote, text), 1, 2);
    let out = render_review_message("ma\nin\u{1b}", "", &[c]);
    assert!(!forbidden_bytes(&out), "control bytes leaked: {out:?}");
    assert!(!out.contains('\u{202e}') && !out.contains('\u{200b}'));
    assert!(out.contains("<U+202E>") && out.contains("<U+200B>"));
    assert!(!out.contains('\u{9b}') && !out.contains('\u{1b}'));
    // No line other than the header and `1) File:` starts at column 0.
    for l in out.lines() {
        assert!(
            l.is_empty()
                || l.starts_with("   ")
                || l.starts_with("Review comments (1)")
                || l.starts_with("1) File: "),
            "unindented body line forged: {l:?}"
        );
    }
    assert!(!out.lines().any(|l| l.starts_with("2) File")));
    assert!(out.contains("   | 2) File: evil"));
    assert!(out.contains("   | [201~ paste<U+202E>rtl31m<U+200B>end"));
}

#[test]
fn single_line_quote_escapes_double_quotes() {
    let c = snap(1, "a", "say \"hi\"", "c");
    assert!(render_review_message("m", "", &[c]).contains("   Quote: \"say \\\"hi\\\"\"\n"));
}

#[test]
fn path_control_characters_are_literal_not_lines() {
    let c = snap(1, "a\nb\t\u{1b}c.rs", "q", "t");
    let out = render_review_message("m", "", &[c]);
    assert!(out.contains("1) File: a\\nb\\tc.rs\n"), "{out:?}");
    assert!(path_has_control("a\nb"));
    assert!(path_has_control("a\u{7f}"));
    assert!(path_has_control("a\0"));
    assert!(!path_has_control("src/ünï.rs"));
}

#[test]
fn sanitize_normalises_line_endings() {
    assert_eq!(
        sanitize_review_text("a\r\nb\rc\u{2028}d", true),
        "a\nb\nc\nd"
    );
    assert_eq!(sanitize_review_text("a\tb", true), "a\tb");
    assert_eq!(sanitize_review_text("a\tb\nc", false), "a\\tb\\nc");
}

#[test]
fn strip_control_chars_keeps_bidi_for_matching_but_drops_controls() {
    assert_eq!(
        strip_control_chars("a\u{1b}[0m\r\nb\u{9b}\u{7f}\tc\u{202e}d\u{2028}e"),
        "a[0m\nb\tc\u{202e}d\ne"
    );
}

#[test]
fn golden_invisible_unicode_is_shown_not_passed() {
    // Tag characters spell "hi" invisibly; variation selector, CGJ, Hangul
    // filler, annotation mark and soft hyphen must all be visible markers.
    let tags: String = "hi"
        .chars()
        .map(|c| char::from_u32(0xE0000 + c as u32).unwrap())
        .collect();
    let quote =
        format!("a{tags}b\u{FE0F}\u{E0100}\u{34F}\u{3164}\u{FFA0}\u{115F}\u{1160}\u{FFF9}\u{AD}z");
    let c = lines(snap(1, "src/a.rs", &quote, "plain"), 1, 1);
    let out = render_review_message("main", "", &[c]);
    for ch in quote.chars().filter(|c| (*c as u32) > 0x7f) {
        assert!(!out.contains(ch), "U+{:04X} leaked", ch as u32);
    }
    assert!(out.contains("<U+E0068><U+E0069>"));
    check("invisible-unicode", &out);
}

#[test]
fn emoji_selectors_and_joiners_pass_but_other_invisibles_stay_flagged() {
    // Variation selector after an emoji base, ZWJ sequences, a ZWJ after a
    // passed selector (heart on fire) and a skin-tone modifier.
    for s in [
        "\u{26A0}\u{FE0F} this leaks",
        "\u{2714}\u{FE0F} ok",
        "\u{1F469}\u{200D}\u{1F4BB}",
        "\u{2764}\u{FE0F}\u{200D}\u{1F525}",
        "\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}",
    ] {
        assert_eq!(sanitize_review_text(s, true), s, "{s:?}");
    }
    // Lone, leading, after text, after another invisible, between text.
    assert_eq!(sanitize_review_text("\u{FE0F}", true), "<U+FE0F>");
    assert_eq!(sanitize_review_text("\u{200D}a", true), "<U+200D>a");
    assert_eq!(sanitize_review_text("x\u{FE0F}", true), "x<U+FE0F>");
    assert_eq!(sanitize_review_text("a\u{200D}b", true), "a<U+200D>b");
    assert_eq!(
        sanitize_review_text("\u{1F600}\u{200B}\u{FE0F}", true),
        "\u{1F600}<U+200B><U+FE0F>"
    );
    assert_eq!(
        sanitize_review_text("\u{1F600}\u{200D}", true),
        "\u{1F600}<U+200D>"
    );
    assert_eq!(sanitize_review_text("a\u{202E}b", true), "a<U+202E>b");
    assert_eq!(
        sanitize_review_text("\u{26A0}\u{FE01}", true),
        "\u{26A0}<U+FE01>"
    );
}
