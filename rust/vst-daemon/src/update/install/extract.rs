//! Safe `.tar.gz` extraction for the CLI archive, ported from
//! `scripts/install.sh:244-279`. Never calls `Archive::unpack`: every entry is
//! inspected and written by hand into a private output directory.

use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use vst_types::rest::update::{UpdateError, UpdateReason};

use super::install_err;

const MAX_ENTRIES: usize = 32;
const MAX_UNPACKED: u64 = 1 << 30;

fn bad(msg: impl Into<String>) -> UpdateError {
    install_err(UpdateReason::WriteFailed, msg)
}

/// `^[A-Za-z0-9][A-Za-z0-9._-]*$` (no leading `.`: it would collide with the
/// `.new`/`.prev` working files).
fn valid_name(n: &str) -> bool {
    let mut it = n.bytes();
    matches!(it.next(), Some(b) if b.is_ascii_alphanumeric())
        && it.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Resolve an entry path to its file name, accepting a flat archive or one
/// wrapping directory. `Err` for absolute / traversal paths; `Ok(None)` for
/// anything deeper than one wrapping dir (ignored, like `install.sh`'s glob).
fn entry_name(path: &Path) -> Result<Option<String>, UpdateError> {
    let mut parts: Vec<String> = Vec::new();
    for c in path.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(bad(format!("unsafe path in archive: {}", path.display())));
            }
        }
    }
    Ok(match parts.len() {
        1 | 2 => parts.pop(),
        _ => None,
    })
}

/// Extract the executables of a CLI archive into `out_dir` (created 0700).
///
/// Returns the written files (sorted). Errors on unsafe paths, invalid file
/// names, more than 32 entries, more than 1 GiB unpacked, or no `vst` binary.
pub fn extract_archive(tar_gz: &Path, out_dir: &Path) -> Result<Vec<PathBuf>, UpdateError> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let io = |e: std::io::Error| bad(format!("cannot extract archive: {e}"));
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(out_dir)
        .map_err(io)?;
    let mut archive = tar::Archive::new(GzDecoder::new(File::open(tar_gz).map_err(io)?));
    let mut written: Vec<PathBuf> = Vec::new();
    let (mut count, mut total) = (0usize, 0u64);
    for entry in archive.entries().map_err(io)? {
        let mut entry = entry.map_err(io)?;
        count += 1;
        if count > MAX_ENTRIES {
            return Err(bad(format!("archive has more than {MAX_ENTRIES} entries")));
        }
        let path = entry.path().map_err(io)?.into_owned();
        let name = entry_name(&path)?;
        if !entry.header().entry_type().is_file() {
            continue; // dirs, symlinks, hardlinks, devices, fifos
        }
        let mode = entry.header().mode().map_err(io)?;
        let Some(name) = name else { continue };
        if mode & 0o111 == 0 {
            continue;
        }
        if !valid_name(&name) {
            return Err(bad(format!("unsafe file name in archive: {name}")));
        }
        total = total.saturating_add(entry.size());
        if total > MAX_UNPACKED {
            return Err(bad("archive unpacks to more than 1 GiB"));
        }
        let dest = out_dir.join(&name);
        if written.contains(&dest) {
            continue;
        }
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&dest)
            .map_err(io)?;
        // `take` guards against a header that understates the real size.
        let copied = std::io::copy(&mut entry.by_ref().take(MAX_UNPACKED), &mut out).map_err(io)?;
        if copied != entry.size() {
            return Err(bad("archive entry is truncated"));
        }
        written.push(dest);
    }
    if !written
        .iter()
        .any(|p| p.file_name().is_some_and(|n| n == "vst"))
    {
        return Err(bad("archive did not contain a 'vst' binary"));
    }
    written.sort();
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(path: &str, kind: tar::EntryType, mode: u32, size: u64) -> tar::Header {
        let mut h = tar::Header::new_gnu();
        // `set_path` rejects `..`/absolute; write raw bytes to craft hostile entries.
        let name = path.as_bytes();
        h.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name);
        h.set_entry_type(kind);
        h.set_mode(mode);
        h.set_size(size);
        h.set_cksum();
        h
    }

    /// Build a `.tar.gz` from `(path, kind, mode, body)` tuples.
    fn build(dir: &Path, entries: &[(&str, tar::EntryType, u32, &[u8])]) -> PathBuf {
        let p = dir.join("a.tar.gz");
        let gz =
            flate2::write::GzEncoder::new(File::create(&p).unwrap(), flate2::Compression::fast());
        let mut b = tar::Builder::new(gz);
        for (path, kind, mode, body) in entries {
            let mut h = header(path, *kind, *mode, body.len() as u64);
            if matches!(kind, tar::EntryType::Symlink | tar::EntryType::Link) {
                h.set_link_name("/etc/passwd").unwrap();
                h.set_cksum();
            }
            b.append(&h, *body).unwrap();
        }
        b.into_inner().unwrap().finish().unwrap();
        p
    }

    const F: tar::EntryType = tar::EntryType::Regular;

    fn names(v: &[PathBuf]) -> Vec<String> {
        v.iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn flat_and_wrapped_yield_vst_and_adapters() {
        let t = tempfile::tempdir().unwrap();
        let flat = build(
            t.path(),
            &[
                ("vst", F, 0o755, b"a"),
                ("claude-acp", F, 0o755, b"b"),
                ("codex-acp", F, 0o755, b"c"),
                ("README", F, 0o644, b"r"),
            ],
        );
        let out = t.path().join("o1");
        let got = extract_archive(&flat, &out).unwrap();
        // The Linux adapters are static musl builds: nothing is dropped on musl.
        assert_eq!(names(&got), ["claude-acp", "codex-acp", "vst"]);
        let wrapped = build(
            t.path(),
            &[
                ("vst-1.0/vst", F, 0o755, b"a"),
                ("vst-1.0/claude-acp", F, 0o755, b"b"),
            ],
        );
        let got = extract_archive(&wrapped, &t.path().join("o2")).unwrap();
        assert_eq!(names(&got), ["claude-acp", "vst"]);
    }

    #[test]
    fn unsafe_entries_are_rejected_or_skipped() {
        let t = tempfile::tempdir().unwrap();
        let ok = ("vst", F, 0o755, &b"a"[..]);
        for bad_path in ["/abs/evil", "../x", "a/../../x"] {
            let a = build(t.path(), &[ok, (bad_path, F, 0o755, b"x")]);
            let out = t.path().join("o");
            assert!(extract_archive(&a, &out).is_err(), "{bad_path}");
            let _ = std::fs::remove_dir_all(&out);
        }
        let a = build(t.path(), &[ok, (".hidden", F, 0o755, b"x")]);
        assert!(extract_archive(&a, &t.path().join("o4")).is_err());
        // symlink + hardlink are skipped, never written
        let a = build(
            t.path(),
            &[
                ok,
                ("link", tar::EntryType::Symlink, 0o755, b""),
                ("hard", tar::EntryType::Link, 0o755, b""),
            ],
        );
        let got = extract_archive(&a, &t.path().join("o5")).unwrap();
        assert_eq!(names(&got), ["vst"]);
        assert!(!t.path().join("o5/link").exists() && !t.path().join("o5/hard").exists());
        // >32 entries
        let many: Vec<(String, tar::EntryType, u32, Vec<u8>)> = (0..33)
            .map(|i| (format!("f{i}"), F, 0o755, vec![0]))
            .collect();
        let refs: Vec<(&str, tar::EntryType, u32, &[u8])> = many
            .iter()
            .map(|(n, k, m, b)| (n.as_str(), *k, *m, b.as_slice()))
            .collect();
        let a = build(t.path(), &refs);
        assert!(extract_archive(&a, &t.path().join("o6")).is_err());
        // nothing escaped
        assert!(!t.path().join("x").exists() && !Path::new("/abs/evil").exists());
    }

    #[test]
    fn missing_vst_is_an_error() {
        let t = tempfile::tempdir().unwrap();
        let a = build(t.path(), &[("claude-acp", F, 0o755, b"b")]);
        assert!(extract_archive(&a, &t.path().join("o")).is_err());
    }
}
