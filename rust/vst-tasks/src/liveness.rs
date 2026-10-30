//! OS probe: "does some process (other than the daemon) hold this output file
//! open?". A running background command keeps its output file open for write
//! until it exits, which is the only end-of-command evidence available when the
//! agent adapter sends no end signal. Bounded (timeout, kill-on-drop);
//! `Unknown` is distinct from `NoWriter`.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::TASK_PROBE_TIMEOUT_MS;

/// One probe result (transient; the registry stores its own per-task state).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Liveness {
    /// Some other process has the file open.
    Alive,
    /// No process has the file open (only when the scan could see everything
    /// it needed to).
    NoWriter,
    /// The probe could not tell (timeout, spawn error, unreadable `/proc`).
    Unknown,
    /// No probe ran (another scan held the one-outstanding slot). A no-op for
    /// the task: liveness and the dead-confirmation counter stay as they were
    /// and the probe is retried soon. Never a real result.
    Skipped,
}

/// Probe seam (tests inject a fake).
pub trait LivenessProbe: Send + Sync {
    /// `path` is already canonical and root-validated (`output::resolve`).
    fn probe<'a>(&'a self, path: &'a Path) -> Pin<Box<dyn Future<Output = Liveness> + Send + 'a>>;
}

/// At most one outstanding OS scan per probe. A timed-out probe abandons its
/// scan but cannot always cancel it, so without this the scans pile up while
/// `/proc` (or `lsof`) is slow.
#[derive(Clone, Copy)]
pub(crate) struct ScanGuard(&'static AtomicBool);

/// Held for the lifetime of one scan; releases the guard on drop.
pub(crate) struct ScanPermit(&'static AtomicBool);

impl ScanGuard {
    pub(crate) fn try_acquire(&self) -> Option<ScanPermit> {
        (!self.0.swap(true, Ordering::AcqRel)).then(|| ScanPermit(self.0))
    }
}

impl Drop for ScanPermit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Run `f` on the blocking pool unless a previous scan is still running
/// (then `Skipped`). The permit is released when `f` returns, not when the
/// caller stops waiting.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
pub(crate) async fn run_exclusive(
    guard: &ScanGuard,
    f: impl FnOnce() -> Liveness + Send + 'static,
) -> Liveness {
    let Some(permit) = guard.try_acquire() else {
        return Liveness::Skipped;
    };
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        f()
    })
    .await
    .unwrap_or(Liveness::Unknown)
}

/// Default probe: Linux `/proc/*/fd` scan, other unix `lsof`, else `Unknown`.
pub struct OsWriterProbe;

/// Process-wide: every registry shares the one scan slot.
static OS_SCAN_BUSY: AtomicBool = AtomicBool::new(false);
const OS_SCANS: ScanGuard = ScanGuard(&OS_SCAN_BUSY);

impl LivenessProbe for OsWriterProbe {
    fn probe<'a>(&'a self, path: &'a Path) -> Pin<Box<dyn Future<Output = Liveness> + Send + 'a>> {
        Box::pin(async move {
            match tokio::time::timeout(
                Duration::from_millis(TASK_PROBE_TIMEOUT_MS),
                probe_os(path, &OS_SCANS),
            )
            .await
            {
                Ok(l) => l,
                Err(_) => {
                    tracing::debug!(path = %path.display(), "task liveness probe timed out");
                    Liveness::Unknown
                }
            }
        })
    }
}

#[cfg(target_os = "linux")]
async fn probe_os(path: &Path, scans: &ScanGuard) -> Liveness {
    let path = path.to_path_buf();
    run_exclusive(scans, move || {
        scan_proc(Path::new("/proc"), &path, &std::process::id().to_string())
    })
    .await
}

/// Scan `<proc_root>/<pid>/fd/*` for a link to `path`, skipping pid `me`.
/// `NoWriter` only when every process it could not inspect is merely gone
/// (`NotFound`) and at least one fd table was readable; an unreadable table
/// (permission, `hidepid`, another pid namespace) means it cannot say.
#[cfg(unix)]
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn scan_proc(proc_root: &Path, path: &Path, me: &str) -> Liveness {
    let Ok(procs) = std::fs::read_dir(proc_root) else {
        return Liveness::Unknown;
    };
    // A command's shell is always our own child, so another user's process can
    // never be its writer: a table we may not read there says nothing. Without
    // this, any host with a root or other-user process (CI runners, the dev
    // sandbox's daemon next to root's init) would make every scan `Unknown`.
    let my_uid = proc_uid(&proc_root.join("self"));
    let (mut readable, mut unreadable, mut foreign) = (0usize, 0usize, 0usize);
    for entry in procs.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str() else { continue };
        if pid == me || pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let fds = match std::fs::read_dir(entry.path().join("fd")) {
            Ok(fds) => fds,
            // Exited between the listing and now: nothing to see.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                if is_foreign(proc_uid(&entry.path()), my_uid) {
                    foreign += 1;
                } else {
                    unreadable += 1;
                }
                continue;
            }
        };
        readable += 1;
        for fd in fds.flatten() {
            if std::fs::read_link(fd.path()).is_ok_and(|t| t == path) {
                return Liveness::Alive;
            }
        }
    }
    // `foreign` entries prove `/proc` is visible; only a scan that saw
    // nothing at all (or a blind spot of our own) cannot say.
    if unreadable > 0 || readable + foreign == 0 {
        Liveness::Unknown
    } else {
        Liveness::NoWriter
    }
}

/// Effective uid of a `/proc/<pid>` entry, from its world-readable `status`
/// file. (The directory's own owner is not used: it reads as root for a
/// process whose credentials just changed, i.e. exactly when it matters.)
#[cfg(unix)]
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn proc_uid(dir: &Path) -> Option<u32> {
    let status = std::fs::read_to_string(dir.join("status")).ok()?;
    let line = status.lines().find_map(|l| l.strip_prefix("Uid:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

/// True only when both owners are known and differ: then the process cannot be
/// one of ours, so being unable to read its fd table is not a blind spot.
#[cfg(unix)]
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn is_foreign(owner: Option<u32>, me: Option<u32>) -> bool {
    matches!((owner, me), (Some(o), Some(m)) if o != m)
}

/// Map one finished `lsof -t -- <file>` run to a result. `NoWriter` only for
/// a clean "nothing has it open" (exit 1, no output at all) or a clean list of
/// just our own pid; any diagnostic output or other exit code is `Unknown`.
#[cfg_attr(not(any(all(unix, not(target_os = "linux")), test)), allow(dead_code))]
fn classify_lsof(code: Option<i32>, stdout: &str, stderr: &str, me: &str) -> Liveness {
    let others = stdout
        .lines()
        .any(|l| !l.trim().is_empty() && l.trim() != me);
    match code {
        Some(0) if others => Liveness::Alive,
        Some(0) if stderr.trim().is_empty() => Liveness::NoWriter,
        Some(1) if stdout.trim().is_empty() && stderr.trim().is_empty() => Liveness::NoWriter,
        _ => Liveness::Unknown,
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
async fn probe_os(path: &Path, scans: &ScanGuard) -> Liveness {
    use std::process::Stdio;
    // Same one-outstanding rule as the `/proc` scan. The spawned task owns the
    // permit and bounds the command itself (dropping it kills `lsof`), so a
    // caller that times out cannot leave the slot held forever.
    let Some(permit) = scans.try_acquire() else {
        return Liveness::Skipped;
    };
    let path = path.to_path_buf();
    let task = tokio::spawn(async move {
        let _permit = permit;
        let run = tokio::process::Command::new("lsof")
            .args(["-n", "-P", "-w", "-t", "--"])
            .arg(&path)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output();
        match tokio::time::timeout(Duration::from_millis(TASK_PROBE_TIMEOUT_MS), run).await {
            Ok(Ok(out)) => classify_lsof(
                out.status.code(),
                &String::from_utf8_lossy(&out.stdout),
                &String::from_utf8_lossy(&out.stderr),
                &std::process::id().to_string(),
            ),
            _ => Liveness::Unknown,
        }
    });
    task.await.unwrap_or(Liveness::Unknown)
}

#[cfg(not(unix))]
async fn probe_os(_path: &Path, _scans: &ScanGuard) -> Liveness {
    Liveness::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;
    use std::sync::Arc;

    /// A scan abandoned by a timeout keeps running; further probes must not
    /// start another one until it finishes.
    #[tokio::test]
    async fn at_most_one_outstanding_scan() {
        let guard = ScanGuard(Box::leak(Box::new(AtomicBool::new(false))));
        let guard = &guard;
        let started = Arc::new(AtomicUsize::new(0));
        let (release, wait) = mpsc::channel::<()>();
        let s1 = started.clone();
        let first = tokio::time::timeout(
            Duration::from_millis(50),
            run_exclusive(guard, move || {
                s1.fetch_add(1, Ordering::SeqCst);
                let _ = wait.recv();
                Liveness::Alive
            }),
        )
        .await;
        assert!(first.is_err(), "first scan is still blocked");
        for _ in 0..5 {
            let s = started.clone();
            let got = run_exclusive(guard, move || {
                s.fetch_add(1, Ordering::SeqCst);
                Liveness::NoWriter
            })
            .await;
            assert_eq!(got, Liveness::Skipped);
        }
        assert_eq!(started.load(Ordering::SeqCst), 1, "no second scan started");
        release.send(()).unwrap();
        // Once the blocked scan finishes, scanning resumes.
        let mut got = Liveness::Skipped;
        for _ in 0..100 {
            got = run_exclusive(guard, || Liveness::NoWriter).await;
            if got == Liveness::NoWriter {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(got, Liveness::NoWriter);
    }

    #[cfg(unix)]
    mod scan {
        use super::super::*;
        use std::os::unix::fs::symlink;

        /// Build `<root>/<pid>/fd/<n>` (None = unreadable fd table).
        fn fake_proc(entries: &[(&str, Option<&Path>)]) -> tempfile::TempDir {
            let root = tempfile::tempdir().unwrap();
            for (pid, target) in entries {
                let d = root.path().join(pid);
                std::fs::create_dir_all(&d).unwrap();
                match target {
                    Some(t) => {
                        std::fs::create_dir_all(d.join("fd")).unwrap();
                        symlink(t, d.join("fd/3")).unwrap();
                    }
                    // A regular file where the fd dir should be: read_dir
                    // fails with something other than NotFound.
                    None => std::fs::write(d.join("fd"), b"").unwrap(),
                }
            }
            root
        }

        #[test]
        fn writer_found_is_alive_even_with_unreadable_neighbours() {
            let f = Path::new("/x/out.output");
            let root = fake_proc(&[("10", None), ("11", Some(f))]);
            assert_eq!(scan_proc(root.path(), f, "1"), Liveness::Alive);
        }

        #[test]
        fn no_writer_only_when_every_fd_table_was_readable() {
            let f = Path::new("/x/out.output");
            let other = Path::new("/x/other");
            let root = fake_proc(&[("10", Some(other)), ("11", Some(other))]);
            assert_eq!(scan_proc(root.path(), f, "1"), Liveness::NoWriter);
        }

        #[test]
        fn unreadable_fd_table_without_a_writer_is_unknown() {
            let f = Path::new("/x/out.output");
            let root = fake_proc(&[("10", Some(Path::new("/x/other"))), ("11", None)]);
            assert_eq!(scan_proc(root.path(), f, "1"), Liveness::Unknown);
        }

        #[test]
        fn only_a_known_different_owner_is_foreign() {
            assert!(is_foreign(Some(0), Some(1000)));
            assert!(!is_foreign(Some(1000), Some(1000)));
            // Unknown ownership stays conservative: an unreadable table counts.
            assert!(!is_foreign(None, Some(1000)));
            assert!(!is_foreign(Some(0), None));
            assert!(!is_foreign(None, None));
        }

        fn set_uid(root: &Path, pid: &str, uid: u32) {
            std::fs::write(
                root.join(pid).join("status"),
                format!("Name:\tx\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n"),
            )
            .unwrap();
        }

        #[test]
        fn proc_uid_reads_the_effective_uid() {
            let root = fake_proc(&[("10", None)]);
            assert_eq!(proc_uid(&root.path().join("10")), None);
            std::fs::write(
                root.path().join("10/status"),
                "Uid:\t1000\t1001\t1000\t1000\n",
            )
            .unwrap();
            assert_eq!(proc_uid(&root.path().join("10")), Some(1001));
        }

        #[test]
        fn another_users_unreadable_table_does_not_hide_no_writer() {
            let f = Path::new("/x/out.output");
            let root = fake_proc(&[
                ("10", Some(Path::new("/x/other"))),
                ("11", None),
                ("self", Some(Path::new("/x/other"))),
            ]);
            set_uid(root.path(), "11", 0);
            set_uid(root.path(), "self", 1000);
            assert_eq!(scan_proc(root.path(), f, "1"), Liveness::NoWriter);
        }

        #[test]
        fn seeing_only_other_users_processes_is_still_no_writer() {
            let f = Path::new("/x/out.output");
            let root = fake_proc(&[("11", None), ("self", Some(Path::new("/x/other")))]);
            set_uid(root.path(), "11", 0);
            set_uid(root.path(), "self", 1000);
            assert_eq!(scan_proc(root.path(), f, "1"), Liveness::NoWriter);
        }

        #[test]
        fn own_users_unreadable_table_still_means_unknown() {
            let f = Path::new("/x/out.output");
            let root = fake_proc(&[
                ("10", Some(Path::new("/x/other"))),
                ("11", None),
                ("self", Some(Path::new("/x/other"))),
            ]);
            set_uid(root.path(), "11", 1000);
            set_uid(root.path(), "self", 1000);
            assert_eq!(scan_proc(root.path(), f, "1"), Liveness::Unknown);
        }

        #[test]
        fn nothing_readable_or_no_proc_is_unknown() {
            let f = Path::new("/x/out.output");
            let empty = fake_proc(&[]);
            assert_eq!(scan_proc(empty.path(), f, "1"), Liveness::Unknown);
            assert_eq!(
                scan_proc(Path::new("/definitely/not/proc"), f, "1"),
                Liveness::Unknown
            );
        }

        #[test]
        fn own_pid_is_skipped() {
            let f = Path::new("/x/out.output");
            let root = fake_proc(&[("10", Some(f)), ("11", Some(Path::new("/x/o")))]);
            assert_eq!(scan_proc(root.path(), f, "10"), Liveness::NoWriter);
        }
    }

    #[test]
    fn lsof_no_writer_needs_a_clean_exit() {
        let c = classify_lsof;
        assert_eq!(c(Some(1), "", "", "9"), Liveness::NoWriter);
        // Exit 1 with a diagnostic is an error, not "nobody has it open".
        assert_eq!(c(Some(1), "", "lsof: WARNING", "9"), Liveness::Unknown);
        assert_eq!(c(Some(1), "5\n", "", "9"), Liveness::Unknown);
        assert_eq!(c(Some(2), "", "", "9"), Liveness::Unknown);
        assert_eq!(c(None, "", "", "9"), Liveness::Unknown);
        assert_eq!(c(Some(0), "5\n9\n", "", "9"), Liveness::Alive);
        assert_eq!(c(Some(0), "9\n", "", "9"), Liveness::NoWriter);
        assert_eq!(c(Some(0), "9\n", "boom", "9"), Liveness::Unknown);
    }
}
