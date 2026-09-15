//! Behavior contract for `slugify.ts` (part 03-git-worktree).
//! Ported 1:1 from `daemon/src/__tests__/slugify.test.ts`.

use vst_git::slugify::{is_safe_project_id, slugify};

#[test]
fn lowercases_and_hyphenates() {
    assert_eq!(slugify("My Cool App"), "my-cool-app");
}

#[test]
fn preserves_internal_dots() {
    assert_eq!(slugify("foo.bar"), "foo.bar");
}

#[test]
fn strips_leading_trailing_dots_and_hyphens() {
    assert_eq!(slugify(".env"), "env");
    assert_eq!(slugify("app."), "app");
    assert_eq!(slugify("--app--"), "app");
}

#[test]
fn never_yields_a_path_traversal_token() {
    assert_eq!(slugify(".."), "project");
    assert_eq!(slugify("."), "project");
    assert_eq!(slugify("..."), "project");
    assert_eq!(slugify("/"), "project");
    assert_eq!(slugify("../../etc"), "etc");
}

#[test]
fn falls_back_to_project_for_empty_or_special_input() {
    assert_eq!(slugify(""), "project");
    assert_eq!(slugify("   "), "project");
    assert_eq!(slugify("@#$%"), "project");
}

#[test]
fn is_safe_project_id_accepts_normal_ids() {
    assert!(is_safe_project_id("my-app"));
    assert!(is_safe_project_id("foo.bar"));
}

#[test]
fn is_safe_project_id_rejects_traversal_tokens_and_separators() {
    assert!(!is_safe_project_id(""));
    assert!(!is_safe_project_id("."));
    assert!(!is_safe_project_id(".."));
    assert!(!is_safe_project_id("a/b"));
    assert!(!is_safe_project_id("a\\b"));
}
