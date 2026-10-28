//! The hardened artifact reader: the ONLY code that opens artifact bytes
//! (plan Decision 5/6). Gate order: canonicalize and require equality with the
//! stored path, denylist on the canonical path, open without following and
//! without blocking, `fstat` the fd for a regular file, compare device/inode
//! with `stat(canonical)`, refuse hard links outside the repo.

use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use crate::paths::{is_denied, is_not_found};

/// Text served per read (first 1 MiB).
pub const TEXT_CAP_BYTES: usize = 1024 * 1024;
/// Largest image served.
pub const IMAGE_CAP_BYTES: u64 = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// What the denylist needs (from the `ScopeResolver`).
#[derive(Clone, Debug, Default)]
pub struct DenyCtx {
    pub vst_home: PathBuf,
    pub registered_roots: Vec<PathBuf>,
}

/// Why an artifact could not be opened.
#[derive(Debug)]
pub enum ReadError {
    /// ENOENT: deleted or moved away.
    NotFound,
    /// The canonical path no longer equals the stored one (symlink swap).
    PathChanged,
    /// Denylist hit, not a regular file, inode swapped, or hard-link escape.
    Denied,
    /// EACCES.
    Unreadable(String),
    Io(io::Error),
}

fn map_io(e: io::Error) -> ReadError {
    if is_not_found(&e) {
        ReadError::NotFound
    } else if e.kind() == io::ErrorKind::PermissionDenied {
        ReadError::Unreadable("EACCES".to_string())
    } else if e.raw_os_error() == Some(libc::ELOOP) {
        // O_NOFOLLOW on a final-component symlink.
        ReadError::Denied
    } else {
        ReadError::Io(e)
    }
}

/// Real path of an open file, from the descriptor itself (`F_GETPATH` on
/// macOS, `/proc/self/fd/N` on Linux). `None` when the platform cannot say.
#[allow(unsafe_code)]
pub fn fd_real_path(file: &File) -> Option<PathBuf> {
    use std::os::fd::AsRawFd;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStringExt;
        let mut buf = [0u8; libc::PATH_MAX as usize];
        // SAFETY: `buf` is PATH_MAX bytes, as F_GETPATH requires; the fd is open.
        let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) };
        if rc == -1 {
            return None;
        }
        let len = buf.iter().position(|b| *b == 0)?;
        Some(PathBuf::from(std::ffi::OsString::from_vec(
            buf[..len].to_vec(),
        )))
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = file;
        None
    }
}

/// Close the window between the path checks and `open`: a parent directory
/// swapped for a symlink in between would make the fd point somewhere else
/// (`O_NOFOLLOW` only covers the last component). The fd's own real path must
/// still be `canon` and must still pass the denylist.
pub fn verify_open_path(file: &File, canon: &Path, deny: &DenyCtx) -> Result<(), ReadError> {
    let Some(real) = fd_real_path(file) else {
        // No way to ask: keep the pre-check result rather than refusing everything.
        return Ok(());
    };
    if real != canon {
        return Err(ReadError::PathChanged);
    }
    if is_denied(&real, &deny.vst_home, &deny.registered_roots) {
        return Err(ReadError::Denied);
    }
    Ok(())
}

/// Open a stored artifact path safely. `allow_hardlink` is `row.in_repo`.
pub fn open_artifact(
    stored: &Path,
    allow_hardlink: bool,
    deny: &DenyCtx,
) -> Result<(File, Metadata), ReadError> {
    let canon = std::fs::canonicalize(stored).map_err(map_io)?;
    if canon != stored {
        return Err(ReadError::PathChanged);
    }
    if is_denied(&canon, &deny.vst_home, &deny.registered_roots) {
        return Err(ReadError::Denied);
    }
    // O_NONBLOCK: opening a FIFO returns instead of hanging; the type check
    // happens on the open fd below.
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(&canon)
        .map_err(map_io)?;
    verify_open_path(&file, &canon, deny)?;
    let post = file.metadata().map_err(map_io)?;
    if !post.file_type().is_file() {
        return Err(ReadError::Denied);
    }
    let pre = std::fs::metadata(&canon).map_err(map_io)?;
    if (pre.dev(), pre.ino()) != (post.dev(), post.ino()) {
        return Err(ReadError::Denied);
    }
    if post.nlink() > 1 && !allow_hardlink {
        return Err(ReadError::Denied);
    }
    Ok((file, post))
}

/// Result of reading an artifact's bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadOutcome {
    /// UTF-8 text, cut at a character boundary when over the cap.
    Text {
        bytes: Vec<u8>,
        /// Full file size in bytes.
        total: u64,
        truncated: bool,
        etag: String,
    },
    Image {
        bytes: Vec<u8>,
        mime: String,
        etag: String,
    },
    /// Row gone or hidden: "No longer an artifact".
    NotFound,
    /// The file was deleted or moved away.
    Missing,
    /// Denylist, path changed, hard link, device/inode mismatch.
    Denied,
    Unreadable {
        detail: String,
    },
    Binary {
        size: u64,
        mime: String,
    },
    TooLarge {
        size: u64,
    },
}

/// MIME for the image extension of `path` (compared case-insensitively).
pub fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return None,
    })
}

fn etag_of(meta: &Metadata) -> String {
    etag_from(meta.ino(), meta.len(), meta.mtime(), meta.mtime_nsec())
}

/// Seconds and nanoseconds stay separate fields: XOR-ing them let different
/// (sec, nsec) pairs collide, and the UI treats an unchanged ETag as "no change".
fn etag_from(ino: u64, len: u64, mtime: i64, mtime_nsec: i64) -> String {
    format!(
        "\"{ino:x}-{len:x}-{:x}.{:x}\"",
        mtime.unsigned_abs(),
        mtime_nsec.unsigned_abs()
    )
}

#[cfg(test)]
mod etag_tests {
    use super::etag_from;

    #[test]
    fn different_second_and_nanosecond_pairs_never_collide() {
        assert_ne!(etag_from(1, 2, 10, 20), etag_from(1, 2, 10 ^ 1, 20 ^ 1));
        assert_ne!(etag_from(1, 2, 3, 4), etag_from(1, 2, 4, 3));
    }
}

fn read_up_to(file: &mut File, cap: usize) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    file.by_ref().take(cap as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Cut `buf` (which holds up to `cap + 4` bytes) to at most `cap` bytes on a
/// UTF-8 character boundary.
fn cut_on_boundary(mut buf: Vec<u8>, cap: usize) -> Vec<u8> {
    if buf.len() <= cap {
        return buf;
    }
    let mut end = cap;
    while end > 0 && (buf[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    buf.truncate(end);
    buf
}

/// Read the bytes of an opened artifact by the contract's branch order: image
/// extension -> image (<= 10 MiB); else NUL in the first 8 KiB -> binary; else
/// text (first 1 MiB).
pub fn read_opened(mut file: File, meta: &Metadata, path: &Path) -> Result<ReadOutcome, ReadError> {
    let size = meta.len();
    let etag = etag_of(meta);
    if let Some(mime) = image_mime(path) {
        if size > IMAGE_CAP_BYTES {
            return Ok(ReadOutcome::TooLarge { size });
        }
        let bytes = read_up_to(&mut file, IMAGE_CAP_BYTES as usize).map_err(map_io)?;
        return Ok(ReadOutcome::Image {
            bytes,
            mime: mime.to_string(),
            etag,
        });
    }
    // Read the cap plus a 4 byte look-ahead so the cut can find a boundary.
    let buf = read_up_to(&mut file, TEXT_CAP_BYTES + 4).map_err(map_io)?;
    if buf[..buf.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return Ok(ReadOutcome::Binary {
            size,
            mime: "application/octet-stream".to_string(),
        });
    }
    let truncated = buf.len() > TEXT_CAP_BYTES;
    let bytes = cut_on_boundary(buf, TEXT_CAP_BYTES);
    Ok(ReadOutcome::Text {
        bytes,
        total: size,
        truncated,
        etag,
    })
}

/// Map a [`ReadError`] to the outcome the response layer renders (`NotFound`
/// is handled by the caller: it triggers move detection first).
pub fn outcome_for_error(e: ReadError) -> ReadOutcome {
    match e {
        ReadError::NotFound => ReadOutcome::Missing,
        ReadError::PathChanged | ReadError::Denied => ReadOutcome::Denied,
        ReadError::Unreadable(detail) => ReadOutcome::Unreadable { detail },
        ReadError::Io(e) => unreadable_internal("artifact read io error", &e, "io error"),
    }
}

/// An internal failure as an `Unreadable` outcome: the cause (sqlite/io text
/// can carry database or file paths) is logged, the client gets a fixed word.
pub fn unreadable_internal(what: &str, cause: &dyn std::fmt::Display, detail: &str) -> ReadOutcome {
    tracing::warn!(error = %cause, "{what}");
    ReadOutcome::Unreadable {
        detail: detail.to_string(),
    }
}

#[cfg(test)]
mod redaction_tests {
    use super::*;

    #[test]
    fn internal_error_text_never_reaches_the_outcome() {
        let io = io::Error::other("/Users/x/.vibe-station/db.sqlite: disk I/O error");
        match outcome_for_error(ReadError::Io(io)) {
            ReadOutcome::Unreadable { detail } => assert_eq!(detail, "io error"),
            other => panic!("{other:?}"),
        }
        match unreadable_internal("t", &"sqlite at /secret/path", "store error") {
            ReadOutcome::Unreadable { detail } => assert_eq!(detail, "store error"),
            other => panic!("{other:?}"),
        }
    }
}
