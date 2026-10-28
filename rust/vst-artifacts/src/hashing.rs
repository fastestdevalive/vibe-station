//! Content hashing (sha-256, files up to 10 MB) and move matching.

use std::fs::File;
use std::io::{self, Read};

use ring::digest::{Context, SHA256};
use vst_store::artifacts::ArtifactRecord;

/// Largest file that is hashed; bigger files get `hash = None`.
pub const HASH_LIMIT_BYTES: u64 = 10 * 1024 * 1024;

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0xf) as usize] as char);
    }
    s
}

/// Stream an open file through sha-256. `Ok(None)` when it is larger than
/// [`HASH_LIMIT_BYTES`] (checked up front and again while reading, so a file
/// that grows underneath us never exceeds the bound).
pub fn sha256_file(file: &mut File) -> io::Result<Option<String>> {
    if file.metadata()?.len() > HASH_LIMIT_BYTES {
        return Ok(None);
    }
    let mut ctx = Context::new(&SHA256);
    let mut buf = vec![0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        total += n as u64;
        if total > HASH_LIMIT_BYTES {
            return Ok(None);
        }
        ctx.update(&buf[..n]);
    }
    Ok(Some(hex(ctx.finish().as_ref())))
}

/// The one live row that `missing` moved to: same scope, same non-NULL hash,
/// not itself missing or hidden. Ambiguous (several) or no hash -> `None`.
pub fn find_move_target<'a>(
    missing: &ArtifactRecord,
    live_rows: &'a [ArtifactRecord],
) -> Option<&'a ArtifactRecord> {
    let hash = missing.hash.as_ref()?;
    let mut found: Option<&ArtifactRecord> = None;
    for r in live_rows {
        if r.id == missing.id
            || r.scope != missing.scope
            || r.missing
            || r.hidden
            || r.hash.as_ref() != Some(hash)
        {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some(r);
    }
    found
}
