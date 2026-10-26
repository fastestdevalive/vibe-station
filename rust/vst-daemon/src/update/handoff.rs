//! Restart-handoff file handling.
//!
//! Preserves AuthState across a planned restart so active browser sessions
//! survive without re-authenticating. Secrets are never logged.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use vst_routes::auth::HandoffAuth;

use super::paths;
use super::timing::HANDOFF_TTL;

/// [`HANDOFF_TTL`] in ms; it must outlive the rollback watcher's whole window
/// (asserted in `watch.rs`'s `timing_budget_holds`), so a rollback after a failed
/// successor boot still finds a valid handoff.
const HANDOFF_TTL_MS: i64 = HANDOFF_TTL.as_millis() as i64;

/// Bump only for a change old readers cannot ignore.
const HANDOFF_FORMAT_VERSION: u32 = 1;

pub struct HandoffData {
    pub auth: HandoffAuth,
    pub port: u16,
}

/// The on-disk handoff. Written by the OLD binary and read by the NEXT one (and by
/// an older one after a rollback): new fields need `#[serde(default)]`; never rename.
/// `v` is the format version (absent in files from before it existed => 0).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredHandoff {
    #[serde(default)]
    v: u32,
    nonce: String,
    expires_at: i64,
    writer_boot_id: String,
    auth: HandoffAuth,
    port: u16,
}

pub fn handoff_path(vst_home: &Path) -> PathBuf {
    paths::handoff(vst_home)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Write handoff data atomically with mode 0600.
///
/// Returns the generated 32-byte hex nonce.
pub fn write(
    vst_home: &Path,
    auth: &HandoffAuth,
    port: u16,
    writer_boot_id: &str,
) -> io::Result<String> {
    let path = handoff_path(vst_home);
    // If a stale handoff file exists, remove it first (writer holds .daemon.lock)
    let _ = fs::remove_file(&path);

    let rng = SystemRandom::new();
    let mut nonce_bytes = [0u8; 32];
    rng.fill(&mut nonce_bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::Other, "random generation failed"))?;
    let mut nonce = String::with_capacity(64);
    for b in nonce_bytes {
        use std::fmt::Write as _;
        let _ = write!(nonce, "{:02x}", b);
    }

    let payload = StoredHandoff {
        v: HANDOFF_FORMAT_VERSION,
        nonce: nonce.clone(),
        expires_at: now_ms() + HANDOFF_TTL_MS,
        writer_boot_id: writer_boot_id.to_string(),
        auth: auth.clone(),
        port,
    };

    let json_bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;

    // Under permissive umask (e.g. umask 000), OpenOptions mode might be affected by umask on some systems.
    // Explicitly set permissions to 0600.
    let _ = file.set_permissions(fs::Permissions::from_mode(0o600));

    file.write_all(&json_bytes)?;
    file.sync_all()?;

    Ok(nonce)
}

/// Consume the handoff file if the nonce matches, the file is valid and not expired.
///
/// Valid ⇒ returns HandoffData, file left in place (caller deletes after bind).
/// Invalid ⇒ deletes file and returns None.
pub fn consume(vst_home: &Path, nonce: &str) -> Option<HandoffData> {
    consume_with_uid(vst_home, nonce, vst_proc::effective_uid())
}

pub(crate) fn consume_with_uid(
    vst_home: &Path,
    nonce: &str,
    expected_uid: u32,
) -> Option<HandoffData> {
    let path = handoff_path(vst_home);

    // Open with custom_flags(libc::O_NOFOLLOW)
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
    {
        Ok(f) => f,
        Err(_) => {
            let _ = fs::remove_file(&path);
            return None;
        }
    };

    let meta = match file.metadata() {
        Ok(m) => m,
        Err(_) => {
            let _ = fs::remove_file(&path);
            return None;
        }
    };

    // Must be regular file
    if !meta.file_type().is_file() {
        let _ = fs::remove_file(&path);
        return None;
    }

    // Owner uid must match effective uid
    if meta.uid() != expected_uid {
        let _ = fs::remove_file(&path);
        return None;
    }

    // Mode check: permissions must be 0600 (mode & 0o777 == 0o600)
    if (meta.permissions().mode() & 0o777) != 0o600 {
        let _ = fs::remove_file(&path);
        return None;
    }

    let stored: StoredHandoff = match serde_json::from_reader(file) {
        Ok(s) => s,
        Err(_) => {
            let _ = fs::remove_file(&path);
            return None;
        }
    };

    // Nonce match check
    if stored.nonce != nonce {
        let _ = fs::remove_file(&path);
        return None;
    }

    // Expiration check
    if stored.expires_at <= now_ms() {
        let _ = fs::remove_file(&path);
        return None;
    }

    Some(HandoffData {
        auth: stored.auth,
        port: stored.port,
    })
}

/// Delete the handoff file.
pub fn delete(vst_home: &Path) {
    let _ = fs::remove_file(handoff_path(vst_home));
}

/// Delete the handoff file once this daemon is actually serving: poll
/// `health_url` every `poll` for up to `give_up`. Returns `true` when the file
/// was deleted. If `/health` never answers (the successor is wedged) the file
/// is left for the rollback watcher, whose restored daemon needs its nonce
///; the TTL reaps it otherwise.
pub async fn delete_once_serving(
    vst_home: PathBuf,
    health_url: String,
    poll: std::time::Duration,
    give_up: std::time::Duration,
) -> bool {
    let client = super::http::timeout_client(std::time::Duration::from_millis(500));
    let started = std::time::Instant::now();
    while started.elapsed() < give_up {
        if let Ok(r) = client.get(&health_url).send().await {
            if r.status().is_success() {
                delete(&vst_home);
                return true;
            }
        }
        tokio::time::sleep(poll).await;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use tempfile::tempdir;

    fn sample_auth() -> HandoffAuth {
        HandoffAuth {
            daemon_token: "secret-token".to_string(),
            browser_epoch: 12345,
            revoked_token_ids: vec!["revoked-1".to_string()],
            sessions: vec![],
        }
    }

    #[test]
    fn test_valid_write_and_consume() {
        let dir = tempdir().unwrap();
        let auth = sample_auth();
        let nonce = write(dir.path(), &auth, 8080, "boot-1").unwrap();

        assert!(handoff_path(dir.path()).exists());
        let meta = fs::metadata(handoff_path(dir.path())).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);

        let consumed = consume(dir.path(), &nonce).expect("should consume valid handoff");
        assert_eq!(consumed.port, 8080);
        assert_eq!(consumed.auth.daemon_token, "secret-token");
        assert_eq!(consumed.auth.browser_epoch, 12345);
        assert!(
            handoff_path(dir.path()).exists(),
            "file should remain after valid consume"
        );

        delete(dir.path());
        assert!(!handoff_path(dir.path()).exists());
    }

    #[test]
    fn handoff_from_older_writer_consumes() {
        let dir = tempdir().unwrap();
        let path = handoff_path(dir.path());
        // No `v`, and the auth/session lack `revoked_token_ids` / `device_name`.
        let json = format!(
            r#"{{"nonce":"n1","expiresAt":{},"writerBootId":"b","port":9,"auth":{{"daemon_token":"t","browser_epoch":3,"sessions":[{{"token_id":"x","scope":"s","issued_at":1,"expires_at":null,"epoch":3}}]}}}}"#,
            now_ms() + 60_000
        );
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .unwrap();
        file.write_all(json.as_bytes()).unwrap();
        let d = consume(dir.path(), "n1").expect("older-format handoff must consume");
        assert_eq!(d.port, 9);
        assert!(d.auth.revoked_token_ids.is_empty());
        assert_eq!(d.auth.sessions[0].device_name, None);
    }

    #[test]
    fn test_nonce_mismatch_deletes_file() {
        let dir = tempdir().unwrap();
        let auth = sample_auth();
        let _nonce = write(dir.path(), &auth, 8080, "boot-1").unwrap();

        let consumed = consume(dir.path(), "wrong-nonce");
        assert!(consumed.is_none());
        assert!(!handoff_path(dir.path()).exists());
    }

    #[test]
    fn test_expired_handoff_deletes_file() {
        let dir = tempdir().unwrap();
        let path = handoff_path(dir.path());

        let payload = StoredHandoff {
            v: HANDOFF_FORMAT_VERSION,
            nonce: "test-nonce".to_string(),
            expires_at: now_ms() - 1000, // expired 1s ago
            writer_boot_id: "boot-1".to_string(),
            auth: sample_auth(),
            port: 8080,
        };
        let bytes = serde_json::to_vec(&payload).unwrap();
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .unwrap();
        file.write_all(&bytes).unwrap();

        let consumed = consume(dir.path(), "test-nonce");
        assert!(consumed.is_none());
        assert!(!path.exists());
    }

    #[test]
    fn test_wrong_mode_deletes_file() {
        let dir = tempdir().unwrap();
        let auth = sample_auth();
        let nonce = write(dir.path(), &auth, 8080, "boot-1").unwrap();
        let path = handoff_path(dir.path());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        let consumed = consume(dir.path(), &nonce);
        assert!(consumed.is_none());
        assert!(!path.exists());
    }

    #[test]
    fn test_symlink_deletes_link() {
        let dir = tempdir().unwrap();
        let real_file = dir.path().join("real.json");
        fs::write(&real_file, b"test").unwrap();
        let link = handoff_path(dir.path());
        symlink(&real_file, &link).unwrap();

        let consumed = consume(dir.path(), "nonce");
        assert!(consumed.is_none());
        assert!(!link.exists());
    }

    #[test]
    fn test_wrong_uid_deletes_file() {
        let dir = tempdir().unwrap();
        let auth = sample_auth();
        let nonce = write(dir.path(), &auth, 8080, "boot-1").unwrap();
        let path = handoff_path(dir.path());

        let current_uid = vst_proc::effective_uid();
        let wrong_uid = current_uid.wrapping_add(100);
        let consumed = consume_with_uid(dir.path(), &nonce, wrong_uid);
        assert!(consumed.is_none());
        assert!(!path.exists());
    }

    #[test]
    fn test_cold_boot_discards() {
        let dir = tempdir().unwrap();
        let auth = sample_auth();
        let _ = write(dir.path(), &auth, 8080, "boot-1").unwrap();
        assert!(handoff_path(dir.path()).exists());

        delete(dir.path());
        assert!(!handoff_path(dir.path()).exists());
    }

    #[test]
    fn test_overwrite_stale_leftover_succeeds() {
        let dir = tempdir().unwrap();
        let auth = sample_auth();
        let nonce1 = write(dir.path(), &auth, 8080, "boot-1").unwrap();
        let nonce2 = write(dir.path(), &auth, 8081, "boot-2").unwrap();
        assert_ne!(nonce1, nonce2);

        let consumed = consume(dir.path(), &nonce2).unwrap();
        assert_eq!(consumed.port, 8081);
    }

    #[test]
    fn ttl_covers_the_watcher_window_d13() {
        use crate::update::timing::{WATCH_PHASE_A_MAX, WATCH_PHASE_B};
        let window = WATCH_PHASE_A_MAX + WATCH_PHASE_B;
        assert!(HANDOFF_TTL_MS as u128 >= window.as_millis() + 30_000);
    }

    #[tokio::test]
    async fn handoff_survives_until_health_serves_d13() {
        use std::time::Duration;
        let dir = tempdir().unwrap();
        write(dir.path(), &sample_auth(), 8080, "boot-1").unwrap();
        // Nothing listens yet: the file must stay.
        let lst = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = lst.local_addr().unwrap();
        drop(lst);
        let url = format!("http://{addr}/health");
        let gone = delete_once_serving(
            dir.path().to_path_buf(),
            url.clone(),
            Duration::from_millis(20),
            Duration::from_millis(200),
        )
        .await;
        assert!(!gone && handoff_path(dir.path()).exists());
        // A server that answers 200: the file is deleted.
        let lst = tokio::net::TcpListener::bind(addr).await.unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            loop {
                let Ok((mut c, _)) = lst.accept().await else {
                    return;
                };
                let mut buf = [0u8; 512];
                let _ = c.read(&mut buf).await;
                let _ = c
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
                    )
                    .await;
            }
        });
        let gone = delete_once_serving(
            dir.path().to_path_buf(),
            url,
            Duration::from_millis(20),
            Duration::from_secs(5),
        )
        .await;
        assert!(gone && !handoff_path(dir.path()).exists());
    }
}
