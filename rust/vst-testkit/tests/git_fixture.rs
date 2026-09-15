//! `vst-testkit` git fixture smoke test.

use vst_testkit::{create_git_fixture, remove_git_fixture};

#[test]
fn git_fixture_creates_a_repo_on_main() {
    let fixture = create_git_fixture("vst-testkit");
    let branch = fixture.git(&["branch", "--show-current"]);
    assert_eq!(branch, "main");
    remove_git_fixture(&fixture);
}
