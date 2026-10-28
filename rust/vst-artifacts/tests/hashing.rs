//! 2.T3: hashing and move matching.

use std::fs::File;
use std::io::Write;

use vst_artifacts::hashing::{find_move_target, sha256_file, HASH_LIMIT_BYTES};
use vst_store::artifacts::ArtifactRecord;
use vst_types::artifacts::{AddedVia, ScopeKey};

fn rec(id: &str, hash: Option<&str>) -> ArtifactRecord {
    ArtifactRecord {
        id: id.into(),
        scope: ScopeKey::worktree("w"),
        path: format!("/p/{id}"),
        path_key: format!("/p/{id}"),
        in_repo: false,
        hash: hash.map(Into::into),
        size: Some(1),
        mtime_ms: Some(1),
        pinned: false,
        pinned_at: None,
        hidden: false,
        missing: false,
        edit_count: 1,
        writers: vec![],
        added_via: AddedVia::Capture,
        created_at: "t".into(),
        last_written_at: "t".into(),
        checked_at: None,
    }
}

#[test]
fn sha256_known_vector_and_empty_file() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("abc");
    std::fs::write(&p, "abc").unwrap();
    assert_eq!(
        sha256_file(&mut File::open(&p).unwrap()).unwrap().unwrap(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let e = d.path().join("empty");
    std::fs::write(&e, "").unwrap();
    assert_eq!(
        sha256_file(&mut File::open(&e).unwrap()).unwrap().unwrap(),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn files_over_ten_megabytes_have_no_hash() {
    let d = tempfile::tempdir().unwrap();
    let big = d.path().join("big.bin");
    let mut f = File::create(&big).unwrap();
    f.set_len(HASH_LIMIT_BYTES + 1).unwrap();
    f.flush().unwrap();
    assert_eq!(sha256_file(&mut File::open(&big).unwrap()).unwrap(), None);
    // Exactly at the limit is still hashed.
    let at = d.path().join("at.bin");
    File::create(&at)
        .unwrap()
        .set_len(HASH_LIMIT_BYTES)
        .unwrap();
    assert!(sha256_file(&mut File::open(&at).unwrap())
        .unwrap()
        .is_some());
}

#[test]
fn unique_hash_match_merges_ambiguous_and_null_do_not() {
    let mut missing = rec("old", Some("h"));
    missing.missing = true;
    let one = vec![rec("new", Some("h")), rec("other", Some("x"))];
    assert_eq!(find_move_target(&missing, &one).unwrap().id, "new");

    let two = vec![rec("new", Some("h")), rec("new2", Some("h"))];
    assert!(find_move_target(&missing, &two).is_none());

    let mut null_missing = rec("old", None);
    null_missing.missing = true;
    let rows = vec![rec("new", None)];
    assert!(find_move_target(&null_missing, &rows).is_none());

    // Missing, hidden and cross-scope rows are not live candidates.
    let mut gone = rec("a", Some("h"));
    gone.missing = true;
    let mut hidden = rec("b", Some("h"));
    hidden.hidden = true;
    let mut other_scope = rec("c", Some("h"));
    other_scope.scope = ScopeKey::worktree("elsewhere");
    assert!(find_move_target(&missing, &[gone, hidden, other_scope]).is_none());
}
