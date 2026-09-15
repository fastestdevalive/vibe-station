//! Behavior contract for `vst-ws::services::ignore_filter` — the
//! directory-aware, nested-gitignore-aware matcher. Ports the key behavior of
//! `daemon/src/services/ignoreFilter.ts` (the node_modules inotify-exhaustion
//! fix and nested-gitignore semantics).

use std::fs;
use tempfile::TempDir;

use vst_ws::services::ignore_filter::build_ignore_matcher;

fn write(dir: &std::path::Path, rel: &str, content: &str) {
    let p = dir.join(rel);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(p, content).unwrap();
}

#[test]
fn always_ignores_node_modules_and_git_anywhere() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), ".gitignore", "");
    let mut m = build_ignore_matcher(tmp.path().to_path_buf());

    assert!(m.ignores(
        tmp.path()
            .join("node_modules/pkg/index.js")
            .to_str()
            .unwrap(),
        false
    ));
    assert!(m.ignores(
        tmp.path().join("src/node_modules/x.js").to_str().unwrap(),
        false
    ));
    assert!(m.ignores(tmp.path().join(".git/HEAD").to_str().unwrap(), false));
    // Plain files not ignored.
    assert!(!m.ignores(tmp.path().join("a.txt").to_str().unwrap(), false));
}

#[test]
fn nested_gitignore_applies_relative_to_its_own_dir() {
    let tmp = TempDir::new().unwrap();
    // Root gitignore does NOT mention node_modules; the nested one does.
    write(tmp.path(), ".gitignore", "");
    write(tmp.path(), "web/.gitignore", "/node_modules\n");
    let mut m = build_ignore_matcher(tmp.path().to_path_buf());

    // web/node_modules is ignored via the NESTED rule, not the root one.
    assert!(m.ignores(
        tmp.path()
            .join("web/node_modules/lodash.js")
            .to_str()
            .unwrap(),
        false
    ));
    // A root-level node_modules would be ignored by the hard exclusion anyway.
    assert!(m.ignores(
        tmp.path().join("node_modules/x.js").to_str().unwrap(),
        false
    ));
    // Non-matching path is not ignored.
    assert!(!m.ignores(tmp.path().join("web/src/app.ts").to_str().unwrap(), false));
}

#[test]
fn outside_worktree_never_ignored() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), ".gitignore", "*\n");
    let mut m = build_ignore_matcher(tmp.path().to_path_buf());
    // A path outside the worktree root (escaped symlink / traversal) must not
    // be ignored even if the matcher would otherwise ignore everything.
    assert!(!m.ignores("/etc/passwd", false));
    assert!(!m.ignores("../other/file.txt", false));
}

#[test]
fn gitignore_patterns_respected() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), ".gitignore", "ignored.txt\nbuild/\n*.log\n");
    let mut m = build_ignore_matcher(tmp.path().to_path_buf());

    assert!(m.ignores(tmp.path().join("ignored.txt").to_str().unwrap(), false));
    // Directory-only pattern: matching a dir entry should be ignored.
    assert!(m.ignores(tmp.path().join("build").to_str().unwrap(), true));
    // The files inside it are ignored too (path contains the build segment).
    assert!(m.ignores(tmp.path().join("build/out.o").to_str().unwrap(), false));
    assert!(m.ignores(tmp.path().join("debug.log").to_str().unwrap(), false));
    assert!(!m.ignores(tmp.path().join("main.rs").to_str().unwrap(), false));
}
