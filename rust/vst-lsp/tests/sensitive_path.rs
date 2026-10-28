//! S20: `is_sensitive_path` is `vst_artifacts::paths::is_denied_prefix(.., &[])`.
//! The LSP denylist keeps denying system/credential dirs and the whole data
//! home, and does NOT gain the artifact-only file-name patterns (dependency
//! files such as `id_arena` must stay readable).

use std::path::Path;

use vst_lsp::is_sensitive_path;

struct Fx {
    _t: tempfile::TempDir,
    home: std::path::PathBuf,
    vst_home: std::path::PathBuf,
}

fn fx() -> Fx {
    let t = tempfile::tempdir().unwrap();
    let home = std::fs::canonicalize(t.path()).unwrap().join("home");
    let vst_home = home.join(".vibe-station");
    for d in [
        home.join(".ssh"),
        home.join(".cargo/registry/src/idx/id_arena-2.2.1/src"),
        vst_home.join("projects/p/worktrees/w"),
    ] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::write(home.join(".ssh/id_rsa"), "k").unwrap();
    std::fs::write(
        home.join(".cargo/registry/src/idx/id_arena-2.2.1/src/lib.rs"),
        "//",
    )
    .unwrap();
    std::fs::write(home.join(".cargo/registry/src/idx/id_token.d.ts"), "//").unwrap();
    std::fs::write(vst_home.join("projects/p/worktrees/w/x.rs"), "//").unwrap();
    Fx {
        _t: t,
        home,
        vst_home,
    }
}

#[test]
fn credential_and_system_paths_are_denied() {
    let f = fx();
    let h = Some(f.vst_home.as_path());
    assert!(is_sensitive_path(&f.home.join(".ssh/id_rsa"), h));
    // case variants (case-insensitive volumes alias them)
    assert!(is_sensitive_path(&f.home.join(".SSH/ID_RSA"), h));
    assert!(is_sensitive_path(Path::new("/etc/passwd"), h));
    assert!(is_sensitive_path(Path::new("/private/etc/hosts"), h));
    assert!(is_sensitive_path(Path::new("/root/.bashrc"), h));
}

#[test]
fn the_whole_data_home_stays_denied_even_for_worktree_files() {
    let f = fx();
    let h = Some(f.vst_home.as_path());
    assert!(is_sensitive_path(
        &f.vst_home.join("projects/p/worktrees/w/x.rs"),
        h
    ));
    assert!(is_sensitive_path(&f.vst_home.join("config.json"), h));
}

#[test]
fn dependency_files_with_id_names_are_not_swept_up() {
    let f = fx();
    let h = Some(f.vst_home.as_path());
    assert!(!is_sensitive_path(
        &f.home
            .join(".cargo/registry/src/idx/id_arena-2.2.1/src/lib.rs"),
        h
    ));
    assert!(!is_sensitive_path(
        &f.home.join(".cargo/registry/src/idx/id_token.d.ts"),
        h
    ));
    // ordinary paths and `.env`-named files are not LSP-denied (artifact-only pattern)
    assert!(!is_sensitive_path(&f.home.join("code/.env"), h));
}
