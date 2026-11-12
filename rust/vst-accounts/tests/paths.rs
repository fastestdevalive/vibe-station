//! `paths::check_chosen` tests: refusal order and the canonical, case-folded,
//! component-wise comparisons (symlinks, string-prefix look-alikes, owners).

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};

use vst_accounts::paths::{
    check_chosen, check_chosen_with, CaseRule, Checked, OtherAccount, PathRefusal,
};

/// A temp home with the accounts root `~/.vibe-station/accounts` and the
/// system login folder `~/.claude`.
struct Fx {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    root: PathBuf,
    system: PathBuf,
}

fn fx() -> Fx {
    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().join("home");
    let root = home.join(".vibe-station").join("accounts");
    let system = home.join(".claude");
    fs::create_dir_all(&root).expect("mkdir root");
    fs::create_dir_all(&system).expect("mkdir system");
    Fx {
        _tmp: tmp,
        home,
        root,
        system,
    }
}

fn check(f: &Fx, input: &str, others: &[OtherAccount]) -> Result<Checked, PathRefusal> {
    check_chosen(input, &f.home, &f.root, Some(&f.system), others)
}

fn other(id: &str, name: &str, dir: &Path) -> OtherAccount {
    OtherAccount {
        id: id.into(),
        name: name.into(),
        dir: dir.to_path_buf(),
    }
}

fn mkdir(p: &Path) -> PathBuf {
    fs::create_dir_all(p).expect("mkdir");
    p.to_path_buf()
}

#[test]
fn paths_relative_rejected() {
    let f = fx();
    assert_eq!(
        check(&f, "relative/dir", &[]).unwrap_err(),
        PathRefusal::Invalid
    );
}

#[test]
fn paths_dotdot_rejected() {
    let f = fx();
    let input = format!("{}/../x", f.home.join("a").display());
    assert_eq!(check(&f, &input, &[]).unwrap_err(), PathRefusal::Invalid);
}

#[test]
fn paths_missing_is_not_found() {
    let f = fx();
    let input = f.home.join("nope").display().to_string();
    assert_eq!(check(&f, &input, &[]).unwrap_err(), PathRefusal::NotFound);
}

#[test]
fn paths_file_is_not_directory() {
    let f = fx();
    let file = f.home.join("f.txt");
    fs::write(&file, "x").expect("write");
    assert_eq!(
        check(&f, &file.display().to_string(), &[]).unwrap_err(),
        PathRefusal::NotADirectory
    );
}

#[test]
fn paths_unreadable_dir() {
    let f = fx();
    let locked = mkdir(&f.home.join("locked"));
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("chmod");
    if fs::read_dir(&locked).is_ok() {
        // Running as root: permissions do not apply, so there is nothing to test.
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).expect("chmod");
        return;
    }
    let result = check(&f, &locked.display().to_string(), &[]);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).expect("restore chmod");
    assert_eq!(result.unwrap_err(), PathRefusal::Unreadable);
}

#[test]
fn paths_home_slash_and_ancestors_are_invalid() {
    let f = fx();
    for input in [
        f.home.display().to_string(),
        "~".to_string(),
        "~/".to_string(),
        "/".to_string(),
        f.home.join(".vibe-station").display().to_string(),
    ] {
        assert_eq!(
            check(&f, &input, &[]).unwrap_err(),
            PathRefusal::TooBroad,
            "input {input:?}"
        );
    }
}

#[test]
fn paths_system_folder_equal_and_inside() {
    let f = fx();
    assert_eq!(
        check(&f, &f.system.display().to_string(), &[]).unwrap_err(),
        PathRefusal::SystemFolder
    );
    let sub = mkdir(&f.system.join("sub"));
    assert_eq!(
        check(&f, &sub.display().to_string(), &[]).unwrap_err(),
        PathRefusal::SystemFolder
    );
}

#[test]
fn paths_symlink_to_system_refused() {
    let f = fx();
    let link = f.home.join("link");
    symlink(&f.system, &link).expect("symlink");
    assert_eq!(
        check(&f, &link.display().to_string(), &[]).unwrap_err(),
        PathRefusal::SystemFolder
    );
}

#[test]
fn paths_inside_accounts_root_names_owner() {
    let f = fx();
    let acc1 = mkdir(&f.root.join("fakecli").join("acc_1"));
    let sub = mkdir(&acc1.join("sub"));
    let others = [other("acc_1", "Work", &acc1)];
    assert_eq!(
        check(&f, &sub.display().to_string(), &others).unwrap_err(),
        PathRefusal::InsideRoot {
            owner: Some("Work".into())
        }
    );
    let acc2 = mkdir(&f.root.join("fakecli").join("acc_2"));
    assert_eq!(
        check(&f, &acc2.display().to_string(), &others).unwrap_err(),
        PathRefusal::InsideRoot { owner: None }
    );
}

#[test]
fn paths_accounts_root_itself_has_no_owner() {
    let f = fx();
    assert_eq!(
        check(&f, &f.root.display().to_string(), &[]).unwrap_err(),
        PathRefusal::InsideRoot { owner: None }
    );
}

#[test]
fn paths_duplicate_exact_case_folded() {
    let f = fx();
    let work = mkdir(&f.home.join("Work-Dir"));
    let others = [other("acc_w", "Work", &work)];
    assert_eq!(
        check(&f, &work.display().to_string(), &others).unwrap_err(),
        PathRefusal::Duplicate {
            id: "acc_w".into(),
            name: "Work".into()
        }
    );
    // Case-folded match: the input is the exact on-disk spelling; the other
    // account's recorded dir differs only in case (and need not exist).
    let home = f.home.canonicalize().unwrap();
    let real = mkdir(&home.join("case-dir"));
    let others = [other("acc_w", "Work", &home.join("CASE-DIR"))];
    assert_eq!(
        check_chosen_with(
            &real.display().to_string(),
            &f.home,
            &f.root,
            Some(&f.system),
            &others,
            CaseRule::Insensitive
        )
        .unwrap_err(),
        PathRefusal::Duplicate {
            id: "acc_w".into(),
            name: "Work".into()
        }
    );
}

#[test]
fn paths_nested_inside_and_around() {
    let f = fx();
    let proj = mkdir(&f.home.join("proj"));
    let sub = mkdir(&proj.join("sub"));
    let inside = [other("acc_p", "Proj", &proj)];
    assert_eq!(
        check(&f, &sub.display().to_string(), &inside).unwrap_err(),
        PathRefusal::Nested {
            id: "acc_p".into(),
            name: "Proj".into(),
            inside: true
        }
    );
    let around = [other("acc_s", "Sub", &sub)];
    assert_eq!(
        check(&f, &proj.display().to_string(), &around).unwrap_err(),
        PathRefusal::Nested {
            id: "acc_s".into(),
            name: "Sub".into(),
            inside: false
        }
    );
}

#[test]
fn paths_string_prefix_is_not_nested() {
    let f = fx();
    let work = mkdir(&f.home.join("work"));
    let look_alike = mkdir(&f.home.join("work-2"));
    let others = [other("acc_w", "Work", &work)];
    let checked = check(&f, &look_alike.display().to_string(), &others).expect("not nested");
    assert_eq!(
        checked.resolved,
        fs::canonicalize(&look_alike).expect("canon")
    );
}

#[test]
fn paths_tilde_expands() {
    let f = fx();
    let work = mkdir(&f.home.join("work"));
    let checked = check(&f, "~/work", &[]).expect("tilde folder is valid");
    assert_eq!(checked.resolved, fs::canonicalize(&work).expect("canon"));
}

#[test]
fn paths_names_only_capped_200() {
    let f = fx();
    let big = mkdir(&f.home.join("big"));
    for i in 0..250 {
        fs::write(big.join(format!("file-{i:03}")), "contents").expect("write");
    }
    let checked = check(&f, &big.display().to_string(), &[]).expect("valid");
    assert_eq!(checked.names.len(), 200);
    assert!(!checked.is_empty);
    assert!(checked.names.iter().all(|n| n.starts_with("file-")));

    let empty = mkdir(&f.home.join("empty"));
    let checked = check(&f, &empty.display().to_string(), &[]).expect("valid");
    assert!(checked.is_empty);
    assert_eq!(checked.names, Vec::<String>::new());
}
