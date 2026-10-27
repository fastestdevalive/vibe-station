//! Output reader hardening (1.T13): one fixture per rejection, real files.

use std::path::{Path, PathBuf};

use vst_tasks::{read_output_file, OutputError};

struct Fx {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

fn fx() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    Fx { _dir: dir, root }
}

impl Fx {
    fn tasks_dir(&self, uid_seg: &str) -> PathBuf {
        let d = self.root.join(uid_seg).join("proj/uuid/tasks");
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn roots(&self) -> Vec<PathBuf> {
        vec![self.root.clone()]
    }

    fn good(&self, id: &str, body: &[u8]) -> PathBuf {
        let p = self.tasks_dir("claude-1000").join(format!("{id}.output"));
        std::fs::write(&p, body).unwrap();
        p
    }
}

async fn read(p: &Path, id: &str, roots: &[PathBuf]) -> Result<vst_tasks::FileTail, OutputError> {
    read_output_file(&p.display().to_string(), id, roots, 200).await
}

#[tokio::test]
async fn reads_the_last_lines_of_a_valid_file() {
    let f = fx();
    let body: String = (0..500).map(|i| format!("line {i}\n")).collect();
    let p = f.good("b1", body.as_bytes());
    let t = read(&p, "b1", &f.roots()).await.unwrap();
    assert_eq!(t.lines.len(), 200);
    assert_eq!(t.lines.last().unwrap(), "line 499");
    assert_eq!(t.lines[0], "line 300");
    assert!(t.truncated);
    assert_eq!(t.total_bytes, body.len() as u64);
}

#[tokio::test]
async fn rejects_a_dotdot_component_before_canonicalising() {
    let f = fx();
    let p = f.good("b1", b"x\n");
    let sneaky = f.tasks_dir("claude-1000").join("../tasks/b1.output");
    assert!(
        p.exists() && sneaky.exists(),
        "the sneaky path really resolves"
    );
    assert_eq!(
        read(&sneaky, "b1", &f.roots()).await,
        Err(OutputError::Rejected)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_a_symlinked_final_component() {
    let f = fx();
    let target = f.good("real", b"secret\n");
    let link = f.tasks_dir("claude-1000").join("b1.output");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert_eq!(
        read(&link, "b1", &f.roots()).await,
        Err(OutputError::Rejected)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_a_symlinked_parent_that_resolves_outside_the_allowlist() {
    let f = fx();
    let outside = tempfile::tempdir().unwrap();
    let outside_root = outside.path().canonicalize().unwrap();
    let real = outside_root.join("claude-1000/proj/uuid/tasks");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::write(real.join("b1.output"), "x\n").unwrap();
    // <root>/claude-1000 -> <outside>/claude-1000
    std::os::unix::fs::symlink(outside_root.join("claude-1000"), f.root.join("claude-1000"))
        .unwrap();
    let p = f.root.join("claude-1000/proj/uuid/tasks/b1.output");
    assert_eq!(read(&p, "b1", &f.roots()).await, Err(OutputError::Rejected));
    // Sanity: with the outside root allowlisted the same path would be fine.
    assert!(read(&p, "b1", &[outside_root]).await.is_ok());
}

#[tokio::test]
async fn rejects_a_path_outside_every_root() {
    let f = fx();
    let p = f.good("b1", b"x\n");
    let other = tempfile::tempdir().unwrap();
    let roots = vec![other.path().canonicalize().unwrap()];
    assert_eq!(read(&p, "b1", &roots).await, Err(OutputError::Rejected));
}

#[tokio::test]
async fn rejects_missing_claude_uid_segment_and_wrong_id_suffix() {
    let f = fx();
    let d = f.tasks_dir("not-claude");
    let p = d.join("b1.output");
    std::fs::write(&p, "x\n").unwrap();
    assert_eq!(read(&p, "b1", &f.roots()).await, Err(OutputError::Rejected));

    let g = f.good("b1", b"x\n");
    assert_eq!(read(&g, "b2", &f.roots()).await, Err(OutputError::Rejected));
    // Non-numeric uid segment.
    let d2 = f.tasks_dir("claude-abc");
    let p2 = d2.join("b1.output");
    std::fs::write(&p2, "x\n").unwrap();
    assert_eq!(
        read(&p2, "b1", &f.roots()).await,
        Err(OutputError::Rejected)
    );
}

#[tokio::test]
async fn rejects_a_directory() {
    let f = fx();
    let d = f.tasks_dir("claude-1000").join("b1.output");
    std::fs::create_dir_all(&d).unwrap();
    assert_eq!(read(&d, "b1", &f.roots()).await, Err(OutputError::Rejected));
}

#[cfg(unix)]
#[tokio::test]
async fn a_fifo_is_rejected_without_hanging() {
    let f = fx();
    let p = f.tasks_dir("claude-1000").join("b1.output");
    let status = std::process::Command::new("mkfifo")
        .arg(&p)
        .status()
        .unwrap();
    assert!(status.success());
    let started = std::time::Instant::now();
    assert_eq!(read(&p, "b1", &f.roots()).await, Err(OutputError::Rejected));
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
}

#[tokio::test]
async fn utf8_split_at_the_cut_decodes_lossily() {
    let f = fx();
    // 3-byte chars, no newlines: the 256 KiB cut lands inside a character
    // (262144 % 3 != 0).
    let body = "€".repeat(100_000);
    let p = f.good("b1", body.as_bytes());
    let t = read(&p, "b1", &f.roots()).await.unwrap();
    assert!(t.truncated);
    assert_eq!(t.lines.len(), 1);
    assert!(
        t.lines[0].starts_with('\u{FFFD}'),
        "split sequence becomes U+FFFD"
    );
    assert!(t.lines[0].ends_with('€'));
}

#[tokio::test]
async fn missing_file_is_an_io_error_not_a_panic() {
    let f = fx();
    let p = f.tasks_dir("claude-1000").join("b1.output");
    assert_eq!(read(&p, "b1", &f.roots()).await, Err(OutputError::Io));
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn macos_tmp_symlink_to_private_tmp_is_accepted() {
    use vst_tasks::default_roots;
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let d = dir.path().join("claude-501/proj/uuid/tasks");
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("b1.output"), "hi\n").unwrap();
    let p = d.join("b1.output");
    assert!(
        p.starts_with("/tmp"),
        "lexical path goes through the /tmp symlink"
    );
    let t = read(&p, "b1", &default_roots()).await.unwrap();
    assert_eq!(t.lines, vec!["hi".to_string()]);
}
