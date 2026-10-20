//! Find the `tailscale` binary, including installs that are not on the daemon's `PATH`.
//!
//! On macOS the standalone / App Store Tailscale ships its CLI inside
//! `Tailscale.app`, so `tailscale` is only reachable through a shell alias —
//! which a daemon never sees. Resolution order:
//! 1. the daemon's own `PATH` (spawned by bare name, exactly as before);
//! 2. directories from the user's interactive-shell `PATH`
//!    (`vst_agents::context::effective_path`, already captured once at boot);
//! 3. well-known install locations (the app bundle, Homebrew, …);
//! 4. last resort, what the user's interactive shell resolves `tailscale` to — this
//!    is how a shell alias pointing at an arbitrary location is found. The answer is
//!    validated (a single absolute executable path) and never run through a shell.
//!
//! Steps 1-3 are a handful of `stat` calls, cheap enough for every status poll, so a
//! newly installed app is picked up on the next Refresh. The shell `PATH` and the
//! alias probe are only reached when the daemon `PATH` misses; the alias probe spawns
//! a shell (bounded, process-group kill) so its result is cached ([`ALIAS_MISS_TTL`]
//! for a miss, keeping Refresh responsive). Async callers use [`locate_async`].

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const APP_BUNDLE_MARKER: &str = ".app/Contents/MacOS/";
pub const MAC_APP_BIN: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Located {
    /// Reachable as `tailscale` through the daemon's own `PATH`.
    OnPath,
    /// Found elsewhere; spawn this (canonicalised) path. The app-bundle binary
    /// is argv0-sensitive, so a symlink must be resolved before it is run.
    OffPath(PathBuf),
    Missing,
}

pub fn locate() -> Located {
    let daemon_path = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    locate_in(
        &daemon_path,
        vst_agents::context::effective_path,
        &candidates(home.as_deref()),
        || shell_alias_target(home.as_deref()),
    )
}

/// [`locate`] off the async runtime (it may spawn the user's shell).
pub async fn locate_async() -> Located {
    tokio::task::spawn_blocking(locate)
        .await
        .unwrap_or(Located::Missing)
}

/// How long a "shell doesn't know `tailscale`" answer is reused.
const ALIAS_MISS_TTL: Duration = Duration::from_secs(10);
const ALIAS_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

static ALIAS_CACHE: Mutex<Option<(Instant, Option<PathBuf>)>> = Mutex::new(None);

fn shell_alias_target(home: Option<&Path>) -> Option<PathBuf> {
    let mut cache = ALIAS_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((at, found)) = cache.as_ref() {
        match found {
            // A positive answer is reused while the target still exists.
            Some(p) if is_executable(p) => return Some(p.clone()),
            Some(_) => {}
            None if at.elapsed() < ALIAS_MISS_TTL => return None,
            None => {}
        }
    }
    let found = vst_agents::context::shell_command_v("tailscale", ALIAS_PROBE_TIMEOUT)
        .and_then(|out| parse_command_v(&out, home));
    *cache = Some((Instant::now(), found.clone()));
    found
}

/// Parse `command -v tailscale` output (`/abs/path`, or `alias tailscale='/abs/path'`
/// / `alias tailscale=/abs/path`) into an existing executable path. Anything that
/// is not a single absolute path — arguments, `sudo`, expansions, a function name —
/// is rejected: we never want to execute something we had to interpret.
pub fn parse_command_v(out: &str, home: Option<&Path>) -> Option<PathBuf> {
    let line = out.lines().next()?.trim();
    let value = match line.strip_prefix("alias ") {
        Some(rest) => rest.strip_prefix("tailscale=")?,
        None => line,
    };
    let value = value
        .strip_prefix('\'')
        .and_then(|v| v.strip_suffix('\''))
        .or_else(|| value.strip_prefix('"').and_then(|v| v.strip_suffix('"')))
        .unwrap_or(value);
    if value.is_empty()
        || value.contains(|c: char| c.is_whitespace() || "$`;&|<>*?(){}\\'\"".contains(c))
    {
        return None;
    }
    let path = match value.strip_prefix("~/") {
        Some(rest) => home?.join(rest),
        None => PathBuf::from(value),
    };
    (path.is_absolute() && is_executable(&path)).then_some(path)
}

pub fn candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut out = vec![PathBuf::from(MAC_APP_BIN)];
    if let Some(h) = home {
        out.push(h.join("Applications/Tailscale.app/Contents/MacOS/Tailscale"));
    }
    for d in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/usr/sbin",
        "/snap/bin",
    ] {
        out.push(Path::new(d).join("tailscale"));
    }
    out
}

/// Pure core of [`locate`] (no process env), for tests.
pub fn locate_in(
    daemon_path: &str,
    shell_path: impl FnOnce() -> String,
    candidates: &[PathBuf],
    alias_target: impl FnOnce() -> Option<PathBuf>,
) -> Located {
    if find_in_path(daemon_path).is_some() {
        return Located::OnPath;
    }
    let hit = find_in_path(&shell_path())
        .or_else(|| candidates.iter().find(|c| is_executable(c)).cloned())
        .or_else(alias_target);
    match hit {
        // Only the app bundle is argv0-sensitive; elsewhere keep the user-visible path
        // (e.g. Homebrew's stable `/opt/homebrew/bin` symlink, not the versioned Cellar).
        Some(p) if p.to_string_lossy().contains(APP_BUNDLE_MARKER) => {
            Located::OffPath(std::fs::canonicalize(&p).unwrap_or(p))
        }
        Some(p) => Located::OffPath(p),
        None => Located::Missing,
    }
}

fn find_in_path(path: &str) -> Option<PathBuf> {
    path.split(':')
        .filter(|d| d.starts_with('/'))
        .map(|d| Path::new(d).join("tailscale"))
        .find(|p| is_executable(p))
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

/// Shell-quote `s` for pasting into a POSIX shell.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The word a user should type to run the CLI from a terminal: bare `tailscale`
/// when it is on `PATH`, otherwise the quoted absolute path.
pub fn display_cmd(l: &Located) -> String {
    match l {
        Located::OffPath(p) => shell_quote(&p.to_string_lossy()),
        _ => "tailscale".to_string(),
    }
}

/// Doctor wording for an off-`PATH` install.
pub fn off_path_message(p: &Path) -> String {
    format!(
        "tailscale found at {} but not on PATH (a shell alias is invisible to vibe-station and scripts). \
         Remote Access works; to run `tailscale` in a terminal: {}",
        p.display(),
        off_path_hint(p)
    )
}

pub fn off_path_hint(p: &Path) -> String {
    if p.to_string_lossy().contains(".app/Contents/MacOS/") {
        "https://tailscale.com/kb/1080/cli#using-the-cli-on-macos".to_string()
    } else {
        let dir = p
            .parent()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default();
        format!("export PATH={}:\"$PATH\"", shell_quote(&dir))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn exe(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn daemon_path_hit_is_on_path() {
        let t = tempfile::tempdir().unwrap();
        exe(t.path(), "tailscale");
        let l = locate_in(t.path().to_str().unwrap(), String::new, &[], || None);
        assert_eq!(l, Located::OnPath);
        assert_eq!(display_cmd(&l), "tailscale");
    }

    #[test]
    fn shell_path_hit_keeps_visible_symlink_path() {
        let t = tempfile::tempdir().unwrap();
        let real = exe(t.path(), "real-ts");
        let bin = t.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        symlink(&real, bin.join("tailscale")).unwrap();
        let l = locate_in(
            "/nonexistent",
            || bin.to_str().unwrap().to_string(),
            &[],
            || None,
        );
        // Not an app bundle: keep the stable user-visible path, not the symlink target.
        assert_eq!(l, Located::OffPath(bin.join("tailscale")));
    }

    #[test]
    fn app_bundle_symlink_is_canonicalised() {
        let t = tempfile::tempdir().unwrap();
        let macos = t.path().join("Tailscale.app/Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let real = exe(&macos, "Tailscale");
        let link = t.path().join("tailscale");
        symlink(&real, &link).unwrap();
        // A symlink whose own path is outside the bundle is kept as-is...
        assert_eq!(
            locate_in("", String::new, std::slice::from_ref(&link), || None),
            Located::OffPath(link)
        );
        // ...a path inside the bundle is resolved.
        let via = macos.join("../MacOS/Tailscale");
        assert_eq!(
            locate_in("", String::new, &[via], || None),
            Located::OffPath(std::fs::canonicalize(&real).unwrap())
        );
    }

    #[test]
    fn candidate_hit_and_missing() {
        let t = tempfile::tempdir().unwrap();
        let app = exe(t.path(), "Tailscale");
        assert!(matches!(
            locate_in("", String::new, &[app], || None),
            Located::OffPath(_)
        ));
        assert_eq!(
            locate_in("", String::new, &[t.path().join("nope")], || None),
            Located::Missing
        );
    }

    #[test]
    fn ignores_non_executable_dirs_and_relative_entries() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("tailscale");
        std::fs::write(&f, "x").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("tailscale")).unwrap();
        let p = format!(":relative:{}:{}", t.path().display(), d.path().display());
        assert_eq!(locate_in(&p, || p.clone(), &[], || None), Located::Missing);
    }

    #[test]
    fn alias_target_is_last_resort() {
        let t = tempfile::tempdir().unwrap();
        let app = exe(t.path(), "Tailscale");
        let l = locate_in("", String::new, &[], || Some(app.clone()));
        assert_eq!(l, Located::OffPath(app));
        // Earlier steps win: the alias probe must not even run.
        let bin = exe(t.path(), "tailscale");
        let l = locate_in("", String::new, std::slice::from_ref(&bin), || {
            panic!("probe ran")
        });
        assert_eq!(l, Located::OffPath(bin));
    }

    #[test]
    fn parses_command_v_output() {
        let t = tempfile::tempdir().unwrap();
        let app = exe(t.path(), "Tailscale");
        let a = app.to_str().unwrap();
        for out in [
            a.to_string(),
            format!("alias tailscale={a}"),
            format!("alias tailscale='{a}'"),
            format!("alias tailscale=\"{a}\""),
            format!("  {a}\n"),
        ] {
            assert_eq!(parse_command_v(&out, None), Some(app.clone()), "{out}");
        }
        let home = t.path();
        assert_eq!(
            parse_command_v("alias tailscale='~/Tailscale'", Some(home)),
            Some(app.clone())
        );
    }

    #[test]
    fn rejects_unsafe_or_non_path_command_v_output() {
        let t = tempfile::tempdir().unwrap();
        let app = exe(t.path(), "Tailscale");
        let a = app.to_str().unwrap();
        for out in [
            "tailscale".to_string(),               // function / relative
            format!("alias tailscale='sudo {a}'"), // arguments
            format!("alias tailscale='{a} --socket=/x'"),
            format!("alias tailscale='{a}; rm -rf ~'"),
            "alias tailscale='$HOME/x'".to_string(),
            "alias tailscale='/does/not/exist'".to_string(), // missing
            "alias other='/bin/ls'".to_string(),             // wrong alias
            String::new(),
        ] {
            assert_eq!(parse_command_v(&out, None), None, "{out}");
        }
    }

    #[test]
    fn quoting_and_hints() {
        assert_eq!(shell_quote("a'b"), r"'a'\''b'");
        let l = Located::OffPath(PathBuf::from("/x y/tailscale"));
        assert_eq!(display_cmd(&l), "'/x y/tailscale'");
        assert!(off_path_hint(Path::new(MAC_APP_BIN)).starts_with("https://"));
        assert_eq!(
            off_path_hint(Path::new("/opt/hb/tailscale")),
            "export PATH='/opt/hb':\"$PATH\""
        );
    }
}
