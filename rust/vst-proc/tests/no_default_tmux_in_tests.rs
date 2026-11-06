//! Guard: no integration test may build a `Tmux` against the user's DEFAULT tmux
//! server. Use `vst_proc::test_support::{isolated_tmux, TmuxGuard}` instead.

use std::path::Path;

fn scan(dir: &Path, hits: &mut Vec<String>, needle: &str) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            scan(&p, hits, needle);
        } else if p.extension().is_some_and(|x| x == "rs") {
            if p.file_name().is_some_and(|n| n == "no_default_tmux_in_tests.rs") {
                continue;
            }
            if std::fs::read_to_string(&p).is_ok_and(|s| s.contains(needle)) {
                hits.push(p.display().to_string());
            }
        }
    }
}

#[test]
fn no_test_uses_default_tmux_server() {
    // Built with format! so this file doesn't match its own needles.
    let needles = [
        format!("Tmux::{}()", "new"),
        format!("Tmux::{}()", "default"),
        format!("spawn_{}(", "tmux"),
    ];
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut hits = vec![];
    for krate in std::fs::read_dir(&root).unwrap().flatten() {
        for needle in &needles {
            scan(&krate.path().join("tests"), &mut hits, needle);
        }
    }
    assert!(hits.is_empty(), "default-server Tmux in tests: {hits:?}");
}
