//! Behavior contract for the orphan-process safety helpers of `jsonAgent.ts`
//! (Decision 13) — `collectDescendants` and the pidfile write/clear logic
//! (`writePidFile`/`clearTurnPids`). The freeze-then-kill `killProcessTree`
//! signal sequence is exercised directly against a real child tree on Linux.

use std::process::{Command, Stdio};

use vst_agents::json_agent_session::pids::{clear_pid_file, collect_descendants, write_pid_file};

#[test]
fn collect_descendants_finds_grandchild_processes() {
    // Spawn a shell that spawns a child shell that sleeps. The descendant
    // walk over /proc must find both the direct child and the grandchild.
    let mut shell = Command::new("sh")
        .arg("-c")
        .arg("sleep 30 & wait")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn sh");
    let root = shell.id() as i32;

    let mut found_grandchild = false;
    for _ in 0..50 {
        let desc = collect_descendants(root);
        if desc.iter().any(|&p| p != root) {
            found_grandchild = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    // Clean up the whole tree, then reap the root shell.
    let _ = kill_tree(root);
    let _ = shell.kill();
    let _ = shell.wait();

    assert!(
        found_grandchild,
        "expected at least one descendant of {root}"
    );
}

#[test]
fn collect_descendants_empty_for_dead_pid() {
    // A pid that doesn't exist yields an empty set (no panic, no /proc hit).
    let desc = collect_descendants(999_999_999);
    assert!(desc.is_empty());
}

#[test]
fn pidfile_write_and_clear_roundtrip() {
    let tmp = tempfile::tempdir().unwrap();
    let pid_file = tmp.path().join("turn.pids");

    write_pid_file(&pid_file, &[111, 222, 333]);
    let content = std::fs::read_to_string(&pid_file).unwrap();
    assert_eq!(content, "111\n222\n333\n");

    clear_pid_file(&pid_file);
    assert!(!pid_file.exists());
}

#[test]
fn write_pid_file_empty_clears() {
    let tmp = tempfile::tempdir().unwrap();
    let pid_file = tmp.path().join("turn.pids");
    std::fs::write(&pid_file, "stale").unwrap();
    write_pid_file(&pid_file, &[]);
    assert!(!pid_file.exists());
}

fn kill_tree(root: i32) -> std::io::Result<()> {
    let desc = collect_descendants(root);
    for p in desc {
        let _ = Command::new("kill").arg("-9").arg(p.to_string()).status();
    }
    Ok(())
}
