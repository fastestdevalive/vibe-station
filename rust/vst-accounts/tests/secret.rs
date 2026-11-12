//! Key-file tests: the sibling `<dir>.key` path, 0600 round-trip, missing-file
//! handling, and an invalid key never appearing in an error.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use vst_accounts::secret::{self, SecretError};

const KEY: &str = "sk-test-0123456789";

/// The account folder path; its parent (`<root>/fakecli`) exists so the sibling
/// key file can be written. The folder itself is never created here.
fn account_dir(root: &Path) -> std::path::PathBuf {
    let parent = root.join("fakecli");
    fs::create_dir_all(&parent).expect("mkdir parent");
    parent.join("acc_1a2b3c4d")
}

#[test]
fn key_path_is_sibling_dot_key() {
    let root = tempfile::tempdir().expect("tempdir");
    let dir = account_dir(root.path());
    let key = secret::key_path(&dir);
    assert_eq!(key.parent(), dir.parent(), "key sits beside the folder");
    assert_eq!(
        key.file_name().expect("name").to_string_lossy(),
        "acc_1a2b3c4d.key"
    );
}

#[test]
fn write_read_roundtrip_mode_0600() {
    let root = tempfile::tempdir().expect("tempdir");
    let dir = account_dir(root.path());
    secret::write_api_key(&dir, KEY).expect("write");

    let mode = fs::metadata(secret::key_path(&dir))
        .expect("key exists")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600);
    assert!(!dir.exists(), "the key file is not inside the folder");
    let read = secret::read_api_key(&dir).expect("read back");
    assert_eq!(read.expose(), KEY);
}

#[test]
fn read_missing_is_none() {
    let root = tempfile::tempdir().expect("tempdir");
    assert!(secret::read_api_key(&account_dir(root.path())).is_none());
}

#[test]
fn remove_api_key_missing_is_ok() {
    let root = tempfile::tempdir().expect("tempdir");
    let dir = account_dir(root.path());
    secret::remove_api_key(&dir).expect("missing key is not an error");

    secret::write_api_key(&dir, KEY).expect("write");
    secret::remove_api_key(&dir).expect("remove");
    assert!(!secret::key_path(&dir).exists());
}

#[test]
fn invalid_key_rejected_never_in_error_text() {
    let root = tempfile::tempdir().expect("tempdir");
    let dir = account_dir(root.path());
    let bad = "sk-SECRET-VALUE\u{7}";
    let err = secret::write_api_key(&dir, bad).expect_err("control char rejected");
    assert!(matches!(err, SecretError::Key(_)));
    let shown = format!("{err} {err:?}");
    assert!(!shown.contains("SECRET-VALUE"), "key leaked: {shown}");
    assert!(!secret::key_path(&dir).exists(), "nothing written");
}

#[test]
fn rewrite_repins_mode_0600_on_existing_file() {
    let root = tempfile::tempdir().expect("tempdir");
    let dir = account_dir(root.path());
    let path = secret::key_path(&dir);
    fs::write(&path, "old-content").expect("seed");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("chmod");
    secret::write_api_key(&dir, KEY).expect("write");
    let meta = fs::metadata(&path).expect("exists");
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    assert_eq!(fs::read_to_string(&path).expect("read"), KEY);
}
