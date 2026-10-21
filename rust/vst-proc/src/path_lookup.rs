//! A tiny `which`-equivalent over `PATH` (std only).

use std::path::PathBuf;

/// Resolve `name` against `PATH`: the first directory holding a regular,
/// executable file of that name. `None` when `PATH` is unset or nothing matches.
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(name);
        if cand.is_file() && is_executable(&cand) {
            return Some(cand);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_p: &std::path::Path) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_binary_every_unix_has() {
        #[cfg(unix)]
        assert!(which("sh").is_some());
    }

    #[test]
    fn missing_binary_is_none() {
        assert_eq!(which("definitely-not-a-real-binary-xyz"), None);
    }
}
