//! `object_exists` distinguishes "definitely absent" from "could not tell".

mod common;

use common::{git, git_fixture, rm_git_fixture};
use vst_git::git::object_exists;

#[tokio::test]
async fn existing_object_is_ok_true_and_missing_object_is_ok_false() {
    let fx = git_fixture("vst-git-object-exists-test").await;
    std::fs::write(fx.dir.join("a.txt"), "a\n").unwrap();
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "c1"]).await;
    let head = git(&fx, &["rev-parse", "HEAD"]).await;
    let repo = fx.dir.to_string_lossy().to_string();

    assert!(object_exists(&repo, &head).await.expect("ran"));
    assert!(!object_exists(&repo, &"f".repeat(40)).await.expect("ran"));

    rm_git_fixture(&fx).await;
}
