//! 2.T1, 2.T5c, 2.T14: path keys, denylist, confinement.

mod common;

use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use vst_artifacts::paths::{
    confine_to_root, display_path, is_denied, is_denied_prefix, is_sane_path, FsProbe, PathKeyer,
    VolumeProbe,
};
use vst_artifacts::ConfineError;

struct Stub {
    calls: AtomicUsize,
    /// (path prefix, device, case-insensitive)
    vols: Vec<(&'static str, u64, bool)>,
}

impl VolumeProbe for Stub {
    fn device_of(&self, dir: &Path) -> Option<u64> {
        self.vols
            .iter()
            .find(|(p, _, _)| dir.starts_with(p))
            .map(|(_, d, _)| *d)
    }
    fn case_insensitive(&self, dir: &Path) -> bool {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.vols
            .iter()
            .find(|(p, _, _)| dir.starts_with(p))
            .is_some_and(|(_, _, ci)| *ci)
    }
}

fn keyer(vols: Vec<(&'static str, u64, bool)>) -> (PathKeyer, Arc<Stub>) {
    let stub = Arc::new(Stub {
        calls: AtomicUsize::new(0),
        vols,
    });
    (PathKeyer::new(stub.clone()), stub)
}

fn tmp() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let p = std::fs::canonicalize(d.path()).unwrap();
    (d, p)
}

#[test]
fn nfc_and_nfd_names_share_one_key() {
    let (k, _) = keyer(vec![("/x", 1, false)]);
    let nfc = Path::new("/x/caf\u{e9}.md");
    let nfd = Path::new("/x/cafe\u{301}.md");
    assert_ne!(nfc.to_string_lossy(), nfd.to_string_lossy());
    assert_eq!(k.key_for(nfc), k.key_for(nfd));
}

#[test]
fn denylist_matches_case_folded_home_entries() {
    let (_d, base) = tmp();
    let vst_home = base.join("home/.vibe-station");
    std::fs::create_dir_all(&vst_home).unwrap();
    let home = base.join("home");
    assert!(is_denied(&home.join(".SSH/ID_RSA"), &vst_home, &[]));
    assert!(is_denied(&home.join(".ssh/anything.txt"), &vst_home, &[]));
    assert!(is_denied(&home.join(".aws/credentials"), &vst_home, &[]));
    assert!(is_denied(
        &home.join(".config/gh/hosts.yml"),
        &vst_home,
        &[]
    ));
    assert!(is_denied(
        &home.join(".claude/.credentials.json"),
        &vst_home,
        &[]
    ));
    assert!(is_denied(
        &home.join("Library/Keychains/login.keychain-db"),
        &vst_home,
        &[]
    ));
    assert!(!is_denied(&home.join(".claude/plans/x.md"), &vst_home, &[]));
    assert!(!is_denied(&home.join("docs/notes.md"), &vst_home, &[]));
    // NFD spelling of a protected name still folds.
    assert!(is_denied(&home.join(".gnupg/pubring.kbx"), &vst_home, &[]));
}

#[test]
fn denylist_covers_this_products_token_and_other_harness_credentials() {
    let (_d, base) = tmp();
    let vst_home = base.join("home/.vibe-station");
    std::fs::create_dir_all(&vst_home).unwrap();
    let home = base.join("home");
    for rel in [
        ".config/vibe-station/claude-oauth-token",
        ".codex/auth.json",
        ".gemini/oauth_creds.json",
        ".local/share/opencode/auth.json",
        ".cursor/cli-config.json",
        ".omp/agent/config.yml",
        ".config/gcloud/credentials.db",
        ".azure/accessTokens.json",
        ".cargo/credentials",
        ".cargo/credentials.toml",
        ".pypirc",
        ".pgpass",
        ".terraform.d/credentials.tfrc.json",
        ".zsh_history",
        ".bash_history",
        ".local/share/keyrings/login.keyring",
    ] {
        assert!(is_denied(&home.join(rel), &vst_home, &[]), "{rel}");
    }
    assert!(!is_denied(&home.join(".cargo/config.toml"), &vst_home, &[]));
    for p in [
        "/proc/self/environ",
        "/sys/kernel/x",
        "/w/a.p12",
        "/w/a.PFX",
        "/w/db.kdbx",
    ] {
        assert!(is_denied(Path::new(p), &vst_home, &[]), "{p}");
    }
}

#[test]
fn name_patterns_and_system_prefixes() {
    let vst_home = PathBuf::from("/nonexistent-home/.vibe-station");
    for p in [
        "/w/id_ed25519",
        "/w/a.pem",
        "/w/a.KEY",
        "/w/.env",
        "/w/.env.local",
    ] {
        assert!(is_denied(Path::new(p), &vst_home, &[]), "{p}");
        assert!(!is_denied_prefix(Path::new(p), &vst_home, &[]), "{p}");
    }
    assert!(is_denied(Path::new("/etc/passwd"), &vst_home, &[]));
    assert!(is_denied(Path::new("/private/etc/hosts"), &vst_home, &[]));
    assert!(is_denied_prefix(Path::new("/etc/passwd"), &vst_home, &[]));
    assert!(is_denied_prefix(
        Path::new("/private/etc/hosts"),
        &vst_home,
        &[]
    ));
    assert!(is_denied_prefix(Path::new("/ETC/passwd"), &vst_home, &[]));
}

#[test]
fn vibe_station_home_denied_except_registered_roots() {
    let (_d, base) = tmp();
    let vst_home = base.join("home/.vibe-station");
    let wt = vst_home.join("projects/p/worktrees/w");
    std::fs::create_dir_all(&wt).unwrap();
    let reg = vec![wt.clone()];
    assert!(is_denied(&wt.join("docs/a.md"), &vst_home, &[]));
    assert!(!is_denied(&wt.join("docs/a.md"), &vst_home, &reg));
    assert!(is_denied(
        &vst_home.join("projects/p/session-data/w/s/x.md"),
        &vst_home,
        &reg
    ));
    assert!(is_denied(&vst_home.join("config.json"), &vst_home, &reg));
    // A name pattern still wins inside a registered root.
    assert!(is_denied(&wt.join(".env"), &vst_home, &reg));
    // LSP semantics: no registered roots, the whole data home is denied.
    assert!(is_denied_prefix(&wt.join("x.rs"), &vst_home, &[]));
}

#[test]
fn id_arena_is_allowed_by_prefix_but_not_by_name_pattern() {
    let vst_home = PathBuf::from("/nonexistent-home/.vibe-station");
    let dep = Path::new("/work/deps/id_arena.rs");
    assert!(is_denied(dep, &vst_home, &[]));
    assert!(!is_denied_prefix(dep, &vst_home, &[]));
    let lib = Path::new("/work/deps/id_arena/src/lib.rs");
    assert!(!is_denied(lib, &vst_home, &[]));
    assert!(!is_denied_prefix(lib, &vst_home, &[]));
}

#[test]
fn confine_rejects_symlink_escape_and_accepts_in_root_links() {
    let (_d, base) = tmp();
    let root = base.join("root");
    let outside = base.join("outside");
    std::fs::create_dir_all(root.join("sub")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "s").unwrap();
    std::fs::write(root.join("sub/real.md"), "r").unwrap();
    symlink(&outside, root.join("leak")).unwrap();
    symlink(root.join("sub/real.md"), root.join("alias.md")).unwrap();
    symlink(&root, base.join("rootlink")).unwrap();

    assert!(matches!(
        confine_to_root(&root, &root.join("leak/secret.txt")),
        Err(ConfineError::Escape)
    ));
    assert!(matches!(
        confine_to_root(&root, &root.join("../outside/secret.txt")),
        Err(ConfineError::Escape)
    ));
    let ok = confine_to_root(&root, &root.join("alias.md")).unwrap();
    assert_eq!(ok, root.join("sub/real.md"));
    // A symlinked root is canonicalized too.
    let ok = confine_to_root(&base.join("rootlink"), &root.join("sub/real.md")).unwrap();
    assert_eq!(ok, root.join("sub/real.md"));
    assert!(matches!(
        confine_to_root(&root, &root.join("nope.md")),
        Err(ConfineError::NotFound)
    ));
}

#[test]
fn display_path_shapes() {
    let root = Path::new("/r/repo");
    let home = Path::new("/Users/me");
    assert_eq!(
        display_path(Some(root), Path::new("/r/repo/docs/a.md"), Some(home)),
        "docs/a.md"
    );
    assert_eq!(
        display_path(
            Some(root),
            Path::new("/Users/me/.claude/plans/x.md"),
            Some(home)
        ),
        "~/.claude/plans/x.md"
    );
    assert_eq!(
        display_path(
            Some(root),
            Path::new("/private/tmp/shots/a.png"),
            Some(home)
        ),
        "/tmp/shots/a.png"
    );
    assert_eq!(
        display_path(None, Path::new("/opt/a.md"), None),
        "/opt/a.md"
    );
}

#[test]
fn sane_paths() {
    assert!(is_sane_path("/a/b.md"));
    assert!(!is_sane_path(""));
    assert!(!is_sane_path("/a/\0b"));
    assert!(!is_sane_path("/a/\nb"));
    assert!(!is_sane_path(&format!("/{}", "a".repeat(4096))));
}

// ── 2.T5c ───────────────────────────────────────────────────────────────

#[test]
fn case_sensitive_volume_keeps_two_rows_insensitive_merges() {
    let (sensitive, _) = keyer(vec![("/v", 1, false)]);
    assert_ne!(
        sensitive.key_for(Path::new("/v/A.md")),
        sensitive.key_for(Path::new("/v/a.md"))
    );
    let (insensitive, _) = keyer(vec![("/v", 1, true)]);
    assert_eq!(
        insensitive.key_for(Path::new("/v/A.md")),
        insensitive.key_for(Path::new("/v/a.md"))
    );
}

#[test]
fn each_device_uses_its_own_probe_result_once() {
    let (k, stub) = keyer(vec![("/ci", 1, true), ("/cs", 2, false)]);
    assert_eq!(
        k.key_for(Path::new("/ci/X.md")),
        k.key_for(Path::new("/ci/x.md"))
    );
    assert_ne!(
        k.key_for(Path::new("/cs/X.md")),
        k.key_for(Path::new("/cs/x.md"))
    );
    // Second pass hits the per-device cache: still exactly two probes.
    let _ = k.key_for(Path::new("/ci/Y.md"));
    let _ = k.key_for(Path::new("/cs/Y.md"));
    assert_eq!(stub.calls.load(Ordering::SeqCst), 2);
}

#[test]
fn fs_probe_uses_nearest_cased_ancestor() {
    let (_d, base) = tmp();
    let dir = base.join("Cased/1234");
    std::fs::create_dir_all(&dir).unwrap();
    let p = FsProbe;
    assert_eq!(
        p.case_insensitive(&dir),
        p.case_insensitive(&base.join("Cased")),
        "a numeric directory name probes its nearest cased ancestor"
    );
    // Cross-check against a direct swapped-case stat.
    let direct = std::fs::metadata(base.join("cASED")).is_ok();
    assert_eq!(p.case_insensitive(&dir), direct);
}

// ── 2.T14 ───────────────────────────────────────────────────────────────

#[test]
fn key_comes_from_canonicalize_not_lexical_normalising() {
    let (_d, base) = tmp();
    let real = base.join("real");
    std::fs::create_dir_all(real.join("sub")).unwrap();
    symlink(real.join("sub"), base.join("link")).unwrap();
    std::fs::write(real.join("x.md"), "x").unwrap();
    let k = PathKeyer::default();
    // Lexically `link/../x.md` is `base/x.md`; the real resolution is real/x.md.
    let got = k.canonicalize_key(&base.join("link/../x.md")).unwrap();
    assert_eq!(got.canonical, real.join("x.md"));
}

#[test]
fn deleted_file_keeps_its_key_and_moved_away_file_uses_canonical_parent() {
    let (_d, base) = tmp();
    let real = base.join("real");
    std::fs::create_dir_all(&real).unwrap();
    symlink(&real, base.join("link")).unwrap();
    let f = real.join("Plan.md");
    std::fs::write(&f, "x").unwrap();
    let k = PathKeyer::default();
    let before = k.canonicalize_key(&f).unwrap();
    std::fs::remove_file(&f).unwrap();
    let after = k.canonicalize_key(&f).unwrap();
    assert_eq!(before, after);
    // The parent is reached through a symlink: still canonical parent + name.
    let via = k.canonicalize_key(&base.join("link/Plan.md")).unwrap();
    assert_eq!(via.canonical, f);
    assert_eq!(via.key, before.key);
    // Parent gone as well: not found.
    assert!(k.canonicalize_key(&base.join("gone/Plan.md")).is_err());
}

#[test]
fn case_insensitive_volume_yields_on_disk_case() {
    let (_d, base) = tmp();
    std::fs::write(base.join("PLAN.md"), "x").unwrap();
    if !FsProbe.case_insensitive(&base.join("zz"))
        && std::fs::metadata(base.join("plan.md")).is_err()
    {
        eprintln!("skipped: case-sensitive volume");
        return;
    }
    let k = PathKeyer::default();
    let a = k.canonicalize_key(&base.join("PLAN.MD")).unwrap();
    let b = k.canonicalize_key(&base.join("plan.md")).unwrap();
    assert_eq!(a.canonical, base.join("PLAN.md"));
    assert_eq!(a.key, b.key);
}
