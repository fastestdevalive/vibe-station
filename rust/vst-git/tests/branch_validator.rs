//! Behavior contract for `branchValidator.ts` (part 03-git-worktree).
//! Ported 1:1 from `daemon/src/__tests__/branchValidator.test.ts`.

use vst_git::branch_validator::validate_branch;

#[test]
fn accepts_valid_branch_names() {
    for name in [
        "fix-auth",
        "feature/my-feature",
        "main",
        "v1.0.0",
        "release-1.2.3",
        "a",
        "ABC",
        "feat/JIRA-123-my-fix",
    ] {
        assert!(validate_branch(name).ok, "expected {name:?} to be valid");
    }
}

#[test]
fn rejects_empty_string() {
    assert!(!validate_branch("").ok);
}

#[test]
fn rejects_names_starting_with_a_dot() {
    assert!(!validate_branch(".feature").ok);
}

#[test]
fn rejects_names_starting_with_a_slash() {
    assert!(!validate_branch("/feature").ok);
}

#[test]
fn rejects_names_containing_double_dot() {
    assert!(!validate_branch("..feature").ok);
    assert!(!validate_branch("feat..ure").ok);
    assert!(!validate_branch("feature..").ok);
}

#[test]
fn rejects_names_with_spaces() {
    assert!(!validate_branch("my feature").ok);
}

#[test]
fn rejects_names_with_special_chars() {
    assert!(!validate_branch("feat@ure").ok);
    assert!(!validate_branch("feat#ure").ok);
    assert!(!validate_branch("feat~ure").ok);
    assert!(!validate_branch("feat^ure").ok);
}

#[test]
fn rejects_names_exceeding_200_chars() {
    let long_name = "a".repeat(201);
    let result = validate_branch(&long_name);
    assert!(!result.ok);
    assert!(result.reason.as_deref().unwrap_or("").contains("200"));
}

#[test]
fn returns_a_reason_string_on_failure() {
    let result = validate_branch("..bad");
    assert!(!result.ok);
    let reason = result.reason.expect("reason must be present");
    assert!(!reason.is_empty());
}
