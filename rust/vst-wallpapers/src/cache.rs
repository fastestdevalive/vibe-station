//! The on-disk image cache: `<key>.img` bytes plus `<key>.json`
//! (`{contentType, sha256}`), where `key` is `<id>-<thumb|full>`.
//!
//! Every write lands in a `*.tmp` sibling first and is renamed into place, so a
//! crash can never leave a half-written entry that reads back as valid. A read
//! re-hashes the bytes: a truncated or tampered file is a miss, not an image.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ring::digest::{digest, SHA256};

/// One cache hit: bytes, their content type, and the sha256 of the bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CachedFile {
    pub bytes: Arc<Vec<u8>>,
    pub content_type: String,
    pub sha256_hex: String,
}

/// Metadata sidecar written next to the bytes.
#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheMeta {
    content_type: String,
    sha256: String,
}

/// The cache directory. Cheap to clone; all state is the path.
#[derive(Clone, Debug)]
pub struct DiskCache {
    dir: PathBuf,
}

impl DiskCache {
    #[must_use]
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Read `key`, or `None` when the entry is absent, unparsable, or its bytes
    /// no longer hash to the recorded sha256.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<CachedFile> {
        if !valid_key(key) {
            return None;
        }
        let meta: CacheMeta = serde_json::from_slice(&fs::read(self.meta_path(key)).ok()?).ok()?;
        let bytes = fs::read(self.image_path(key)).ok()?;
        if sha256_hex(&bytes) != meta.sha256 {
            return None;
        }
        Some(CachedFile {
            bytes: Arc::new(bytes),
            content_type: meta.content_type,
            sha256_hex: meta.sha256,
        })
    }

    /// Store `key`. The returned value is always usable for serving: a write
    /// failure (disk full, read-only dir) is logged and the caller still gets
    /// the bytes it just fetched. Takes ownership so serving a just-fetched
    /// image costs no copy.
    #[must_use]
    pub fn put(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> CachedFile {
        let sha256_hex = sha256_hex(&bytes);
        let cached = CachedFile {
            bytes: Arc::new(bytes),
            content_type: content_type.to_owned(),
            sha256_hex: sha256_hex.clone(),
        };
        if !valid_key(key) {
            tracing::warn!("wallpaper cache: refusing unsafe cache key");
            return cached;
        }
        if let Err(error) = self.write_entry(key, &cached.bytes, content_type, &sha256_hex) {
            tracing::warn!("wallpaper cache: write failed for {key}: {error}");
        }
        cached
    }

    fn write_entry(
        &self,
        key: &str,
        bytes: &[u8],
        content_type: &str,
        sha256_hex: &str,
    ) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        write_atomic(&self.image_path(key), bytes)?;
        let meta = CacheMeta {
            content_type: content_type.to_owned(),
            sha256: sha256_hex.to_owned(),
        };
        let json = serde_json::to_vec(&meta).map_err(std::io::Error::other)?;
        write_atomic(&self.meta_path(key), &json)
    }

    fn image_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.img"))
    }

    fn meta_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.json"))
    }
}

/// Cache keys are `<id>-<size>`; anything that could escape the directory is
/// refused (the id comes from a URL path, so it is never trusted).
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && !key.contains('/')
        && !key.contains('\\')
        && !key.contains("..")
        && key != "."
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.flush()?;
    }
    fs::rename(&tmp, path)
}

fn sha256_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let digest = digest(&SHA256, bytes);
    let mut hex = String::with_capacity(digest.as_ref().len() * 2);
    for byte in digest.as_ref() {
        hex.push(DIGITS[(byte >> 4) as usize] as char);
        hex.push(DIGITS[(byte & 0xf) as usize] as char);
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache(dir: &Path) -> DiskCache {
        DiskCache::new(dir.to_path_buf())
    }

    #[test]
    fn put_then_get_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = cache(tmp.path());
        let cached = cache.put("wp-001-full", b"image bytes".to_vec(), "image/jpeg");
        let hit = cache.get("wp-001-full").unwrap();
        assert_eq!(hit.bytes.as_slice(), b"image bytes");
        assert_eq!(hit.content_type, "image/jpeg");
        assert_eq!(hit.sha256_hex, cached.sha256_hex);
    }

    #[test]
    fn corrupt_file_is_a_miss() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = cache(tmp.path());
        let _ = cache.put("wp-002-thumb", b"original bytes".to_vec(), "image/jpeg");
        // Same length, different content: the recorded sha no longer matches.
        fs::write(tmp.path().join("wp-002-thumb.img"), b"tampered bytes").unwrap();
        assert!(cache.get("wp-002-thumb").is_none());

        // A truncated file (short cache entry) is a miss too.
        let _ = cache.put("wp-003-full", b"0123456789".to_vec(), "image/png");
        fs::write(tmp.path().join("wp-003-full.img"), b"0123").unwrap();
        assert!(cache.get("wp-003-full").is_none());
    }

    #[test]
    fn rejects_path_traversal_key() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("wallpapers");
        let cache = cache(&root);
        let _ = cache.put("../evil", b"x".to_vec(), "image/png");
        let _ = cache.put("a/b", b"x".to_vec(), "image/png");
        assert!(cache.get("../evil").is_none());
        assert!(cache.get("a/b").is_none());
        assert!(!tmp.path().join("evil.img").exists());
        assert!(!root.join("a").exists());
    }

    #[test]
    fn put_is_atomic_no_tmp_left() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = cache(tmp.path());
        let _ = cache.put("wp-004-full", b"bytes".to_vec(), "image/jpeg");
        let leftovers: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name.to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        assert!(cache.get("wp-004-full").is_some());
    }

    #[test]
    fn sha_is_stable_lowercase_hex() {
        let tmp = tempfile::tempdir().unwrap();
        let cached = cache(tmp.path()).put("wp-005-full", b"abc".to_vec(), "image/jpeg");
        assert_eq!(cached.sha256_hex, sha256_hex(b"abc"));
        assert_eq!(
            cached.sha256_hex,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(cached
            .sha256_hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }
}
