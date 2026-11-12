//! Account-folder tests: shared-entry symlinks (named and `AllExcept`), a
//! dangling/missing entry skipped, a failed link never fatal, and the slug /
//! managed-folder create and guarded delete rules.

mod common;

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::Path;

use vst_accounts::folders;
use vst_types::{SharedEntries, SharedSet};

fn names(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(dir)
        .expect("read dir")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}

#[test]
fn shared_entries_symlinked_and_dangling_skipped() {
    let root = tempfile::tempdir().expect("tempdir");
    let source = root.path().join("system");
    fs::create_dir_all(source.join("skills")).expect("mkdir skills");
    fs::write(source.join("settings.json"), "{}").expect("write settings");
    symlink(source.join("does-not-exist"), source.join("broken")).expect("dangling link");

    let dir = folders::create_account_dir(root.path(), common::CLI, "acc_1a2b3c4d")
        .expect("create account dir");
    folders::link_shared_entries(
        &dir,
        &SharedEntries {
            source_dir: source.clone(),
            set: SharedSet::Named(vec!["skills", "settings.json", "broken", "missing"]),
        },
    );

    assert_eq!(names(&dir), vec!["settings.json", "skills"]);
    assert!(
        fs::symlink_metadata(dir.join("skills"))
            .expect("linked")
            .file_type()
            .is_symlink(),
        "shared entries are symlinks, not copies"
    );
}

#[test]
fn shared_entry_link_failure_is_not_fatal() {
    let root = tempfile::tempdir().expect("tempdir");
    let source = root.path().join("system");
    fs::create_dir_all(source.join("skills")).expect("mkdir skills");

    let dir = folders::create_account_dir(root.path(), common::CLI, "acc_1a2b3c4d")
        .expect("create account dir");
    // An existing target is never overwritten (and is not an error).
    fs::write(dir.join("skills"), "already here").expect("write existing");
    folders::link_shared_entries(
        &dir,
        &SharedEntries {
            source_dir: source,
            set: SharedSet::Named(vec!["skills"]),
        },
    );
    assert_eq!(
        fs::read_to_string(dir.join("skills")).expect("read"),
        "already here"
    );

    // A missing source dir is skipped, never fatal.
    folders::link_shared_entries(
        &dir,
        &SharedEntries {
            source_dir: root.path().join("no-such-dir"),
            set: SharedSet::AllExcept(vec![]),
        },
    );
}

#[test]
fn shared_entries_all_except_links_everything_else() {
    let root = tempfile::tempdir().expect("tempdir");
    let source = root.path().join("config");
    for name in ["fakecli", "gh", "git"] {
        fs::create_dir_all(source.join(name)).expect("mkdir");
    }
    let dir = folders::create_account_dir(root.path(), common::CLI, "acc_1a2b3c4d")
        .expect("create account dir");
    folders::link_shared_entries(
        &dir,
        &SharedEntries {
            source_dir: source,
            set: SharedSet::AllExcept(vec!["fakecli"]),
        },
    );
    assert_eq!(
        names(&dir),
        vec!["gh", "git"],
        "the account's own dir is excluded; every other entry is linked"
    );
}

#[test]
fn slugify_rules() {
    assert_eq!(folders::slugify("Work!!"), "work");
    assert_eq!(folders::slugify("  Client B  "), "client-b");
    assert_eq!(folders::slugify("日本語"), "", "unicode-only is empty");
    assert_eq!(folders::slugify(""), "");
    assert_eq!(folders::slugify(&"a".repeat(60)).len(), 40, "capped at 40");
    let capped = folders::slugify(&format!("{}-b", "a".repeat(39)));
    assert!(!capped.ends_with('-'), "no trailing dash after the cap");
}

#[test]
fn create_managed_dir_collision_suffix() {
    let root = tempfile::tempdir().expect("tempdir");
    let first =
        folders::create_managed_dir(root.path(), common::CLI, "Work", "acc_1").expect("first");
    let second =
        folders::create_managed_dir(root.path(), common::CLI, "Work", "acc_2").expect("second");
    let fallback =
        folders::create_managed_dir(root.path(), common::CLI, "!!", "acc_9").expect("fallback");
    assert_eq!(first.file_name().expect("name"), "work");
    assert_eq!(second.file_name().expect("name"), "work-2");
    assert_eq!(fallback.file_name().expect("name"), "acc_9");
}

#[test]
fn create_managed_dir_mode_0700() {
    let root = tempfile::tempdir().expect("tempdir");
    let dir =
        folders::create_managed_dir(root.path(), common::CLI, "Work", "acc_1").expect("create");
    let mode = fs::metadata(&dir).expect("meta").permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);
}

#[test]
fn remove_managed_dir_refuses_depth_other_than_two() {
    let root = tempfile::tempdir().expect("tempdir");
    let cli_dir = root.path().join(common::CLI);
    let acc = cli_dir.join("acc_1");
    fs::create_dir_all(&acc).expect("mkdir acc");
    fs::write(acc.join("keep.txt"), "keep").expect("write");
    let sibling = tempfile::tempdir().expect("sibling");
    fs::write(sibling.path().join("keep.txt"), "keep").expect("write sibling");

    let bad = [
        root.path().to_path_buf(),
        cli_dir.clone(),
        cli_dir.join(".."),
        cli_dir.join("."),
        root.path().join(".."),
        sibling.path().to_path_buf(),
    ];
    for dir in &bad {
        let removed = folders::remove_managed_dir(root.path(), common::CLI, dir).expect("guard");
        assert!(!removed, "refused: {}", dir.display());
    }
    assert!(acc.join("keep.txt").exists(), "account folder untouched");
    assert!(cli_dir.exists(), "cli folder untouched");
    assert!(
        sibling.path().join("keep.txt").exists(),
        "sibling untouched"
    );
}

#[test]
fn remove_managed_dir_does_not_follow_symlinks() {
    let root = tempfile::tempdir().expect("tempdir");
    let outside = tempfile::tempdir().expect("outside");
    fs::write(outside.path().join("precious.txt"), "keep").expect("write");
    let acc = root.path().join(common::CLI).join("acc_1");
    fs::create_dir_all(&acc).expect("mkdir acc");
    symlink(outside.path(), acc.join("link")).expect("symlink");

    assert!(folders::remove_managed_dir(root.path(), common::CLI, &acc).expect("remove"));
    assert!(!acc.exists(), "managed folder removed");
    assert_eq!(
        fs::read_to_string(outside.path().join("precious.txt")).expect("read"),
        "keep",
        "the symlink target is never followed"
    );
}

#[test]
fn remove_managed_dir_symlinked_dir_removes_only_link() {
    let root = tempfile::tempdir().expect("tempdir");
    let outside = tempfile::tempdir().expect("outside");
    fs::write(outside.path().join("precious.txt"), "keep").expect("write");
    let cli_dir = root.path().join(common::CLI);
    fs::create_dir_all(&cli_dir).expect("mkdir cli");
    let link = cli_dir.join("acc_link");
    symlink(outside.path(), &link).expect("symlink");

    assert!(folders::remove_managed_dir(root.path(), common::CLI, &link).expect("remove"));
    assert!(
        fs::symlink_metadata(&link).is_err(),
        "the link itself is removed"
    );
    assert!(outside.path().join("precious.txt").exists());
}

#[test]
fn is_managed_dir_rejects_wrong_cli_segment() {
    let root = tempfile::tempdir().expect("tempdir");
    let acc = root.path().join(common::CLI).join("acc_1");
    fs::create_dir_all(&acc).expect("mkdir acc");
    assert!(folders::is_managed_dir(root.path(), common::CLI, &acc));
    assert!(!folders::is_managed_dir(root.path(), "claude", &acc));
}
