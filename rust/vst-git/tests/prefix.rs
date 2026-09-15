//! Behavior contract for `prefix.ts` (part 03-git-worktree).
//! Ported 1:1 from `daemon/src/__tests__/prefix.test.ts`.

use vst_git::prefix::{generate_project_prefix, make_unique_prefix};

#[test]
fn uses_short_ids_as_is() {
    assert_eq!(generate_project_prefix("api"), "api");
}

#[test]
fn takes_first_3_chars_of_a_single_word() {
    assert_eq!(generate_project_prefix("testrepo"), "tes");
}

#[test]
fn uses_initials_for_kebab_or_snake_case() {
    assert_eq!(generate_project_prefix("agent-orchestrator"), "ao");
}

#[test]
fn returns_the_base_when_free() {
    assert_eq!(make_unique_prefix("tes", &|_| false).unwrap(), "tes");
}

#[test]
fn appends_the_next_free_numeric_suffix_on_collision() {
    assert_eq!(make_unique_prefix("tes", &|p| p == "tes").unwrap(), "tes2");
    assert_eq!(
        make_unique_prefix("tes", &|p| p == "tes" || p == "tes2").unwrap(),
        "tes3"
    );
}

#[test]
fn keeps_the_result_within_the_6_char_cap_by_trimming_the_stem() {
    let out = make_unique_prefix("abcdef", &|p| p == "abcdef").unwrap();
    assert!(out.len() <= 6);
    assert_eq!(out, "abcde2");
}
