//! Orphan-process safety (Decision 13) — ports `jsonAgent.ts`'s
//! `collectDescendants` / `killProcessTree` free functions and the turn-pid
//! pidfile write/clear logic. Follows `vst-git::recover`'s pattern of driving
//! signals through the `kill` command (no libc dependency).

use std::collections::HashMap;
use std::path::Path;

/// Enumerate every descendant PID of `root_pid` by walking `/proc` PPID links.
/// Linux-only; returns `[]` if `/proc` is unavailable. Mirrors
/// `collectDescendants` — claude's Bash tool spawns commands in their own
/// session group, so they are not in the turn root's group but remain
/// descendants until the root dies.
pub fn collect_descendants(root_pid: i32) -> Vec<i32> {
    let mut children_of: HashMap<i32, Vec<i32>> = HashMap::new();
    let entries = match std::fs::read_dir("/proc") {
        Ok(e) => e,
        Err(_) => return Vec::new(), // no /proc (non-Linux) — group-kill is the only lever
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let pid: i32 = match name.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(s) => s,
            Err(_) => continue, // race: process exited while scanning
        };
        // `pid (comm) state ppid …` — comm can contain spaces/parens, so split
        // after the last ')': fields are then [state, ppid, …].
        let Some(idx) = stat.rfind(')') else { continue };
        let rest: Vec<&str> = stat[idx + 2..].split(' ').collect();
        let Some(ppid) = rest.get(1).and_then(|s| s.parse::<i32>().ok()) else {
            continue;
        };
        children_of.entry(ppid).or_default().push(pid);
    }
    let mut out: Vec<i32> = Vec::new();
    let mut stack = vec![root_pid];
    while let Some(pid) = stack.pop() {
        for child in children_of.get(&pid).cloned().unwrap_or_default() {
            out.push(child);
            stack.push(child);
        }
    }
    out
}

fn signal(pid: i32, sig: &str) {
    let _ = std::process::Command::new("kill")
        .arg(format!("-{sig}"))
        .arg(pid.to_string())
        .status();
}

fn signal_group(pid: i32, sig: &str) {
    let _ = std::process::Command::new("kill")
        .arg(format!("-{sig}"))
        .arg("--")
        .arg(format!("-{pid}"))
        .status();
}

/// Kill each root turn PID AND its whole descendant tree so NO tool subprocess
/// survives a stop / DELETE. The tree is FROZEN (SIGSTOP) before it is killed
/// (SIGKILL) — a stopped process cannot fork, closing the escapee race.
/// Best-effort throughout.
pub fn kill_process_tree(root_pids: impl IntoIterator<Item = i32>) {
    let roots: Vec<i32> = root_pids.into_iter().filter(|&p| p > 1).collect();
    if roots.is_empty() {
        return;
    }

    // Freeze the roots first so they can't spawn while we walk the tree.
    let mut frozen: Vec<i32> = Vec::new();
    for &root in &roots {
        signal_group(root, "STOP");
        signal(root, "STOP");
        frozen.push(root);
    }
    // Enumerate + freeze descendants to a fixed point.
    for _pass in 0..8 {
        let mut grew = false;
        for &root in &roots {
            for pid in collect_descendants(root) {
                if frozen.contains(&pid) {
                    continue;
                }
                signal_group(pid, "STOP");
                signal(pid, "STOP");
                frozen.push(pid);
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    // Now reap the whole frozen tree (SIGKILL overrides SIGSTOP).
    for pid in frozen {
        signal_group(pid, "KILL");
        signal(pid, "KILL");
    }
}

/// Write the live turn PIDs to the pidfile (one per line). Empty → remove the
/// file. Mirrors `writePidFile`.
pub fn write_pid_file(pid_file: &Path, pids: &[i32]) {
    if pids.is_empty() {
        clear_pid_file(pid_file);
        return;
    }
    if let Some(dir) = pid_file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let content = pids
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let _ = std::fs::write(pid_file, format!("{content}\n"));
}

/// Remove the pidfile (best-effort).
pub fn clear_pid_file(pid_file: &Path) {
    let _ = std::fs::remove_file(pid_file);
}
