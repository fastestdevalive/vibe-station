//! Find the `cloudflared` binary and report whether it actually runs.
//!
//! vibe-station no longer bundles `cloudflared`, so the one on disk is the
//! user's own (Homebrew, apt, winget, …). Resolution order (first hit wins):
//! 1. `VST_CLOUDFLARED_BIN` — authoritative: a missing / non-executable value is
//!    a visible [`CloudflaredBinary::Unusable`], never a silent fall-through
//!    (a stale override from an older desktop build must not be ignored);
//! 2. the daemon's own `PATH`;
//! 3. the user's interactive-shell `PATH` (`vst_agents::context::effective_path`,
//!    captured once at boot — a GUI-launched macOS daemon has a minimal `PATH`);
//! 4. well-known install locations (`Homebrew`, `MacPorts`, `/usr/local`, `~/.local`,
//!    Windows installer / winget dirs).
//!
//! The stat walk is a handful of `stat` calls and runs off the async runtime;
//! only [`probe`] spawns anything, bounded by [`PROBE_TIMEOUT`]. Nothing is
//! cached: a fresh install is picked up on the next Re-check without restarting
//! the daemon.

use std::path::{Path, PathBuf};
use std::time::Duration;

use vst_types::rest::mobile_auth::CloudflaredBinary;

/// Upper bound on `cloudflared --version` (AGENTS.md "external probes are bounded").
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// What the stat walk found, before any probe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FindResult {
    /// An executable to probe.
    Found(PathBuf),
    /// `VST_CLOUDFLARED_BIN` is set but points at something we can't run.
    /// Authoritative: earlier/later steps are never consulted.
    OverrideUnusable { path: PathBuf, error: String },
    /// Nothing on PATH, the shell PATH or the well-known dirs.
    NotFound,
}

/// Locate + probe `cloudflared`, fresh on every call.
pub async fn resolve() -> CloudflaredBinary {
    let found = tokio::task::spawn_blocking(|| {
        let override_bin = std::env::var("VST_CLOUDFLARED_BIN").ok();
        let daemon_path = std::env::var("PATH").unwrap_or_default();
        let shell_path = vst_agents::context::effective_path();
        let home = std::env::var_os("HOME").map(PathBuf::from);
        find(
            override_bin.as_deref(),
            &daemon_path,
            &shell_path,
            &candidates(home.as_deref(), std::env::consts::OS),
        )
    })
    .await
    .unwrap_or(FindResult::NotFound);

    match found {
        FindResult::NotFound => CloudflaredBinary::NotInstalled,
        FindResult::OverrideUnusable { path, error } => CloudflaredBinary::Unusable {
            path: path.display().to_string(),
            error,
        },
        FindResult::Found(path) => match probe(&path, PROBE_TIMEOUT).await {
            Ok(version) => CloudflaredBinary::Installed {
                path: path.display().to_string(),
                version,
            },
            Err(error) => CloudflaredBinary::Unusable {
                path: path.display().to_string(),
                error,
            },
        },
    }
}

/// Pure core of [`resolve`]'s stat walk (no env reads), for tests.
pub fn find(
    override_bin: Option<&str>,
    path_env: &str,
    shell_path: &str,
    candidates: &[PathBuf],
) -> FindResult {
    if let Some(bin) = override_bin.map(str::trim).filter(|b| !b.is_empty()) {
        // A bare name (`VST_CLOUDFLARED_BIN=cloudflared`) is a PATH lookup, not a
        // cwd-relative path — the daemon's PATH first, then the user's shell PATH.
        // Still authoritative: no hit anywhere is `Unusable`, not a fall-through
        // to the well-known dirs.
        if !bin.contains('/') && !bin.contains('\\') {
            return match find_in_path(path_env).or_else(|| find_in_path(shell_path)) {
                Some(p) => FindResult::Found(p),
                None => FindResult::OverrideUnusable {
                    error: format!(
                        "{bin} was not found on PATH (set by VST_CLOUDFLARED_BIN — unset it or restart the daemon)"
                    ),
                    path: PathBuf::from(bin),
                },
            };
        }
        let path = PathBuf::from(bin);
        return if is_executable(&path) {
            FindResult::Found(path)
        } else {
            FindResult::OverrideUnusable {
                error: format!(
                    "{bin} is not an executable file (set by VST_CLOUDFLARED_BIN — unset it or restart the daemon)"
                ),
                path,
            }
        };
    }
    if let Some(p) = find_in_path(path_env) {
        return FindResult::Found(p);
    }
    if let Some(p) = find_in_path(shell_path) {
        return FindResult::Found(p);
    }
    if let Some(p) = candidates.iter().find(|c| is_executable(c)).cloned() {
        return FindResult::Found(p);
    }
    FindResult::NotFound
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    }
}

fn find_in_path(path_env: &str) -> Option<PathBuf> {
    std::env::split_paths(path_env)
        .filter(|d| d.is_absolute())
        .map(|d| d.join(binary_name()))
        .find(|p| is_executable(p))
}

/// Well-known install dirs. Windows dirs are only produced when `os` is
/// "windows" (no Windows daemon build ships today, so they stay minimal).
pub fn candidates(home: Option<&Path>, os: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if os == "windows" {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(dir) = std::env::var_os(var) {
                out.push(Path::new(&dir).join("cloudflared").join(binary_name()));
            }
        }
        if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
            out.push(
                Path::new(&dir)
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links")
                    .join(binary_name()),
            );
        }
        return out;
    }
    for d in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/opt/local/bin",
    ] {
        out.push(Path::new(d).join(binary_name()));
    }
    if let Some(h) = home {
        out.push(h.join(".local").join("bin").join(binary_name()));
    }
    out
}

/// Run `cloudflared --version` and return the version token.
///
/// `kill_on_drop` + the timeout keep a hung binary from outliving the probe;
/// a non-zero exit, spawn error or timeout is an `Err` message (never a fake
/// version), which [`resolve`] reports as [`CloudflaredBinary::Unusable`].
///
/// # Errors
///
/// Returns the human-readable reason the binary can't be used (spawn failure,
/// non-zero exit, timeout, or no version output).
pub async fn probe(path: &Path, timeout: Duration) -> Result<String, String> {
    // ETXTBSY (errno 26): the file is still open for writing somewhere (an
    // installer mid-copy, or a parallel fork inheriting a just-closed write
    // fd). It clears within milliseconds, so retry inside the same budget.
    const ETXTBSY: i32 = 26;
    let run = async {
        loop {
            let mut cmd = tokio::process::Command::new(path);
            cmd.arg("--version")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            match cmd.output().await {
                Err(e) if e.raw_os_error() == Some(ETXTBSY) => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                other => return other,
            }
        }
    };

    let output = match tokio::time::timeout(timeout, run).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("could not run it: {e}")),
        Err(_) => {
            return Err(format!(
                "`--version` timed out after {}s",
                timeout.as_secs()
            ))
        }
    };

    if !output.status.success() {
        let code = output
            .status
            .code()
            .map_or_else(|| "a signal".to_string(), |c| format!("exit code {c}"));
        return Err(
            match first_line(&output.stderr).or_else(|| first_line(&output.stdout)) {
                Some(detail) => format!("`--version` failed with {code}: {detail}"),
                None => format!("`--version` failed with {code}"),
            },
        );
    }

    let line = first_line(&output.stdout)
        .or_else(|| first_line(&output.stderr))
        .ok_or_else(|| "`--version` printed nothing".to_string())?;
    Ok(parse_version_line(&line))
}

fn first_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// `cloudflared version 2025.1.0 (built 2025-01-06-…)` → `2025.1.0`; anything
/// unrecognised falls back to the whole (trimmed) line rather than failing.
pub fn parse_version_line(line: &str) -> String {
    let line = line.trim();
    let rest = line.strip_prefix("cloudflared version ").unwrap_or(line);
    match rest.split_whitespace().next() {
        Some(first) if !first.is_empty() => first.to_string(),
        _ => line.to_string(),
    }
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::cloudflared::{EnvVarGuard, ENV_LOCK};
    use std::os::unix::fs::PermissionsExt;

    fn write_bin(dir: &Path, name: &str, body: &str, mode: u32) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
        p
    }

    fn exe(dir: &Path, name: &str) -> PathBuf {
        write_bin(dir, name, "#!/bin/sh\nexit 0\n", 0o755)
    }

    fn path_of(p: &Path) -> String {
        p.to_str().unwrap().to_string()
    }

    #[test]
    fn override_executable_wins_over_every_other_step() {
        let t = tempfile::tempdir().unwrap();
        let override_bin = exe(t.path(), "custom-cloudflared");
        let on_path = exe(t.path(), "cloudflared");
        let r = find(
            Some(&path_of(&override_bin)),
            &path_of(t.path()),
            &path_of(t.path()),
            &[on_path],
        );
        assert_eq!(r, FindResult::Found(override_bin));
    }

    #[test]
    fn missing_override_is_unusable_and_never_falls_through() {
        let t = tempfile::tempdir().unwrap();
        let on_path = exe(t.path(), "cloudflared");
        let missing = t.path().join("nope");
        let r = find(
            Some(&path_of(&missing)),
            &path_of(t.path()),
            &path_of(t.path()),
            &[on_path],
        );
        match r {
            FindResult::OverrideUnusable { path, error } => {
                assert_eq!(path, missing);
                assert!(
                    error.contains("VST_CLOUDFLARED_BIN"),
                    "override error should name the env var: {error}"
                );
            }
            other => panic!("expected OverrideUnusable, got {other:?}"),
        }
    }

    #[test]
    fn blank_override_counts_as_unset() {
        let t = tempfile::tempdir().unwrap();
        let on_path = exe(t.path(), "cloudflared");
        assert_eq!(
            find(Some("   "), &path_of(t.path()), "", &[]),
            FindResult::Found(on_path)
        );
    }

    #[test]
    fn bare_name_override_is_resolved_via_path() {
        let t = tempfile::tempdir().unwrap();
        let bin = exe(t.path(), "cloudflared");
        // `VST_CLOUDFLARED_BIN=cloudflared` must not be read as a cwd-relative
        // path: resolve it on the daemon PATH (authoritative override).
        assert_eq!(
            find(Some("cloudflared"), &path_of(t.path()), "", &[]),
            FindResult::Found(bin)
        );
    }

    #[test]
    fn bare_name_override_falls_back_to_the_shell_path() {
        let t = tempfile::tempdir().unwrap();
        let bin = exe(t.path(), "cloudflared");
        assert_eq!(
            find(Some("cloudflared"), "/nonexistent", &path_of(t.path()), &[]),
            FindResult::Found(bin)
        );
    }

    #[test]
    fn bare_name_override_missing_from_path_is_unusable() {
        let t = tempfile::tempdir().unwrap();
        let r = find(Some("cloudflared"), &path_of(t.path()), "", &[]);
        match r {
            FindResult::OverrideUnusable { path, error } => {
                assert_eq!(path, PathBuf::from("cloudflared"));
                assert!(error.contains("was not found on PATH"), "{error}");
                assert!(error.contains("VST_CLOUDFLARED_BIN"), "{error}");
            }
            other => panic!("expected OverrideUnusable, got {other:?}"),
        }
    }

    #[test]
    fn daemon_path_hit() {
        let t = tempfile::tempdir().unwrap();
        let bin = exe(t.path(), "cloudflared");
        assert_eq!(
            find(None, &path_of(t.path()), "", &[]),
            FindResult::Found(bin)
        );
    }

    #[test]
    fn shell_path_hit_when_daemon_path_misses() {
        let t = tempfile::tempdir().unwrap();
        let bin = exe(t.path(), "cloudflared");
        assert_eq!(
            find(None, "/nonexistent", &path_of(t.path()), &[]),
            FindResult::Found(bin)
        );
    }

    #[test]
    fn well_known_candidate_hit() {
        let t = tempfile::tempdir().unwrap();
        let bin = exe(t.path(), "cloudflared");
        assert_eq!(
            find(None, "", "", std::slice::from_ref(&bin)),
            FindResult::Found(bin)
        );
    }

    #[test]
    fn nothing_anywhere_is_not_found() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(
            find(
                None,
                "",
                "",
                &[t.path().join("cloudflared"), t.path().join("missing")]
            ),
            FindResult::NotFound
        );
    }

    #[test]
    fn non_executable_files_and_directories_are_skipped() {
        let t = tempfile::tempdir().unwrap();
        let plain = write_bin(t.path(), "cloudflared", "#!/bin/sh\n", 0o644);
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("cloudflared")).unwrap();
        let p = format!(":relative:{}:{}", t.path().display(), dir.path().display());
        assert_eq!(
            find(None, &p, &p, std::slice::from_ref(&plain)),
            FindResult::NotFound
        );

        // The same file is still rejected (not run) as an override.
        match find(Some(&path_of(&plain)), "", "", &[]) {
            FindResult::OverrideUnusable { error, .. } => {
                assert!(error.contains("not an executable file"), "{error}")
            }
            other => panic!("expected OverrideUnusable, got {other:?}"),
        }
    }

    #[test]
    fn version_line_is_parsed_tolerantly() {
        assert_eq!(
            parse_version_line("cloudflared version 2025.1.0 (built 2025-01-06-1200 UTC)"),
            "2025.1.0"
        );
        assert_eq!(
            parse_version_line("  cloudflared version 2026.10.0\n"),
            "2026.10.0"
        );
        assert_eq!(parse_version_line("2025.1.0"), "2025.1.0");
        assert_eq!(parse_version_line(""), "");
    }

    #[tokio::test]
    async fn probe_parses_a_real_version_string() {
        let t = tempfile::tempdir().unwrap();
        let bin = write_bin(
            t.path(),
            "cloudflared",
            "#!/bin/sh\necho 'cloudflared version 2025.1.0 (built x)'\n",
            0o755,
        );
        assert_eq!(probe(&bin, PROBE_TIMEOUT).await, Ok("2025.1.0".to_string()));
    }

    #[tokio::test]
    async fn probe_reports_a_non_zero_exit() {
        let t = tempfile::tempdir().unwrap();
        let bin = write_bin(
            t.path(),
            "cloudflared",
            "#!/bin/sh\necho 'boom' >&2\nexit 1\n",
            0o755,
        );
        let err = probe(&bin, PROBE_TIMEOUT).await.unwrap_err();
        assert!(err.contains("exit code 1"), "{err}");
        assert!(err.contains("boom"), "{err}");
    }

    /// A killed-but-unreaped child is a zombie: `kill -0` still succeeds for it,
    /// so ask `ps` for the process state instead (empty = gone, `Z` = dead).
    fn process_is_dead(pid: u32) -> bool {
        let out = std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "state="])
            .output();
        match out {
            Ok(out) => {
                let state = String::from_utf8_lossy(&out.stdout)
                    .trim()
                    .to_ascii_uppercase();
                state.is_empty() || state.starts_with('Z')
            }
            Err(_) => true,
        }
    }

    #[tokio::test]
    async fn probe_times_out_and_kills_the_child() {
        // The fake script `exec`s `sleep` through PATH, which the env tests rewrite.
        let _guard = ENV_LOCK.lock().await;
        let t = tempfile::tempdir().unwrap();
        let pid_file = t.path().join("pid");
        let bin = write_bin(
            t.path(),
            "cloudflared",
            &format!(
                "#!/bin/sh\necho $$ > '{}'\nexec sleep 30\n",
                pid_file.display()
            ),
            0o755,
        );
        let started = std::time::Instant::now();
        let err = probe(&bin, Duration::from_secs(1)).await.unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "probe must return promptly on timeout, took {:?}",
            started.elapsed()
        );

        let mut pid = None;
        for _ in 0..100 {
            if let Ok(s) = std::fs::read_to_string(&pid_file) {
                pid = s.trim().parse::<u32>().ok();
                if pid.is_some() {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let pid = pid.expect("the fake cloudflared should record its pid before sleeping");

        let mut dead = false;
        for _ in 0..100 {
            if process_is_dead(pid) {
                dead = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(dead, "the timed-out child {pid} must be killed, not leaked");
    }

    #[tokio::test]
    async fn resolve_reports_installed_through_the_override() {
        let _guard = ENV_LOCK.lock().await;
        let t = tempfile::tempdir().unwrap();
        let bin = write_bin(
            t.path(),
            "cloudflared",
            "#!/bin/sh\necho 'cloudflared version 2025.1.0 (built x)'\n",
            0o755,
        );
        let _env = EnvVarGuard::set("VST_CLOUDFLARED_BIN", &bin);
        let resolved = resolve().await;

        assert_eq!(
            resolved,
            CloudflaredBinary::Installed {
                path: path_of(&bin),
                version: "2025.1.0".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn resolve_reports_a_non_executable_override_as_unusable() {
        let _guard = ENV_LOCK.lock().await;
        let t = tempfile::tempdir().unwrap();
        let bin = write_bin(t.path(), "cloudflared", "#!/bin/sh\n", 0o644);
        let _env = EnvVarGuard::set("VST_CLOUDFLARED_BIN", &bin);
        let resolved = resolve().await;

        match resolved {
            CloudflaredBinary::Unusable { path, error } => {
                assert_eq!(path, path_of(&bin));
                assert!(error.contains("not an executable file"), "{error}");
            }
            other => panic!("expected Unusable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn resolve_resolves_a_bare_name_override_on_path() {
        let _guard = ENV_LOCK.lock().await;
        let t = tempfile::tempdir().unwrap();
        let bin = write_bin(
            t.path(),
            "cloudflared",
            "#!/bin/sh\necho 'cloudflared version 2025.1.0 (built x)'\n",
            0o755,
        );
        // The daemon PATH must contain the temp dir for the bare-name lookup.
        let _env = EnvVarGuard::set("VST_CLOUDFLARED_BIN", "cloudflared");
        let _path = EnvVarGuard::set("PATH", path_of(t.path()));
        let resolved = resolve().await;

        assert_eq!(
            resolved,
            CloudflaredBinary::Installed {
                path: path_of(&bin),
                version: "2025.1.0".to_string(),
            }
        );
    }
}
