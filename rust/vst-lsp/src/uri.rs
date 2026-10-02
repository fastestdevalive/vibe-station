//! `file://` URI <-> filesystem path conversion for LSP traffic.
//!
//! Servers percent-encode URIs (a space is `%20`, a literal `%` is `%25`), so a
//! bare `strip_prefix("file://")` produces a path that doesn't exist on disk for
//! any project whose path contains one of those bytes. Both directions go through
//! here so outgoing and incoming URIs agree.

use std::path::{Path, PathBuf};

#[cfg(unix)]
use percent_encoding::percent_encode;
#[cfg(not(unix))]
use percent_encoding::utf8_percent_encode;
use percent_encoding::{percent_decode_str, AsciiSet, CONTROLS};

/// Bytes escaped in the path component of an outgoing `file://` URI: everything
/// RFC 3986 doesn't allow unescaped in a path segment (`/` stays literal).
const PATH_ESCAPE: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

/// `/a b/c.rs` -> `file:///a%20b/c.rs`. On Unix the raw path bytes are
/// encoded, so a non-UTF-8 file name round-trips instead of turning into
/// U+FFFD (which names a different, nonexistent file).
pub fn path_to_uri(path: &Path) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        format!(
            "file://{}",
            percent_encode(path.as_os_str().as_bytes(), PATH_ESCAPE)
        )
    }
    #[cfg(not(unix))]
    {
        format!(
            "file://{}",
            utf8_percent_encode(&path.to_string_lossy(), PATH_ESCAPE)
        )
    }
}

/// `file:///a%20b/c.rs` -> `/a b/c.rs`. Accepts an empty or `localhost`
/// authority only. Returns `None` for non-`file` URIs (e.g. rust-analyzer's
/// `rust-analyzer-builtin:` virtual documents), for a remote authority
/// (`file://host/x` must not become the relative path `host/x`), and — off
/// Unix — for undecodable bytes.
pub fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let rest = match rest.strip_prefix("localhost") {
        Some(after) if after.starts_with('/') => after,
        _ => rest,
    };
    if !rest.starts_with('/') {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let bytes: Vec<u8> = percent_decode_str(rest).collect();
        Some(PathBuf::from(std::ffi::OsStr::from_bytes(&bytes)))
    }
    #[cfg(not(unix))]
    {
        let decoded = percent_decode_str(rest).decode_utf8().ok()?;
        Some(PathBuf::from(decoded.as_ref()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(
            uri_to_path("file:///home/me/my%20proj/100%25/a.rs"),
            Some(PathBuf::from("/home/me/my proj/100%/a.rs"))
        );
    }

    #[test]
    fn accepts_localhost_authority() {
        assert_eq!(
            uri_to_path("file://localhost/tmp/a.rs"),
            Some(PathBuf::from("/tmp/a.rs"))
        );
    }

    #[test]
    fn rejects_remote_authority() {
        assert_eq!(uri_to_path("file://otherhost/etc/passwd"), None);
        assert_eq!(uri_to_path("file://localhostfoo/x.rs"), None);
        assert_eq!(uri_to_path("file:relative/x.rs"), None);
    }

    #[cfg(unix)]
    #[test]
    fn roundtrips_non_utf8_file_names() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let p = Path::new(OsStr::from_bytes(b"/tmp/a\xffb.rs"));
        let uri = path_to_uri(p);
        assert_eq!(uri, "file:///tmp/a%FFb.rs");
        assert_eq!(uri_to_path(&uri), Some(p.to_path_buf()));
    }

    #[test]
    fn rejects_non_file_scheme() {
        assert_eq!(uri_to_path("rust-analyzer-builtin:///x"), None);
    }

    #[test]
    fn roundtrips_special_characters() {
        let p = Path::new("/tmp/a b/100%/é#x.rs");
        let uri = path_to_uri(p);
        assert_eq!(uri, "file:///tmp/a%20b/100%25/%C3%A9%23x.rs");
        assert_eq!(uri_to_path(&uri), Some(p.to_path_buf()));
    }

    #[test]
    fn plain_paths_are_unchanged() {
        assert_eq!(
            path_to_uri(Path::new("/tmp/.tmpAb12/src/lib.rs")),
            "file:///tmp/.tmpAb12/src/lib.rs"
        );
    }
}
