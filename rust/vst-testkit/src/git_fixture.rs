//! Shared "real temp git repo" test fixture — `mkdtemp` + `git init` + a thin
//! `std::process::Command` wrapper — used by any unit test that needs to run
//! actual `git` commands against a throwaway repo. Mirrors the TS
//! `daemon/src/__tests__/gitFixture.ts`.
//!
//! Note (rust-coding §4): this is a synchronous subprocess wrapper intended
//! for synchronous test code, not for use inside `async fn` bodies running on
//! the tokio scheduler — tests that need `git` from an async context should
//! wrap these calls in `spawn_blocking`.

use std::path::PathBuf;
use std::process::Command;

/// A fresh temp git repo on branch `main` with test author/email configured.
pub struct GitFixture {
    /// The temp repo's absolute path.
    pub dir: PathBuf,
}

impl GitFixture {
    /// Run `git <args>` in the fixture dir, returning trimmed stdout.
    ///
    /// # Panics
    /// Panics if `git` is not on `PATH`, exits non-zero, or fails to spawn.
    /// This is a test helper, so panicking on harness failure is the intent.
    pub fn git(&self, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.dir)
            .args(args)
            .output()
            .expect("failed to spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout)
            .expect("git stdout was not UTF-8")
            .trim()
            .to_string()
    }
}

/// Create a fresh temp git repo (branch `main`, test author/email configured).
///
/// # Panics
/// Panics if `git` is unavailable or any init command fails.
pub fn create_git_fixture(prefix: &str) -> GitFixture {
    let dir = temp_dir().join(format!("{prefix}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("failed to create temp repo dir");
    let fixture = GitFixture { dir };
    fixture.git(&["init", "-q", "-b", "main"]);
    fixture.git(&["config", "user.email", "test@example.com"]);
    fixture.git(&["config", "user.name", "Test"]);
    fixture
}

/// Remove a fixture's temp directory. Call from test teardown.
pub fn remove_git_fixture(fixture: &GitFixture) {
    let _ = std::fs::remove_dir_all(&fixture.dir);
}

fn temp_dir() -> PathBuf {
    std::env::temp_dir()
}
