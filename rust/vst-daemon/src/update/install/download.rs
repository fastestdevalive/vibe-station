//! Verified asset download: stream to disk while hashing, enforce
//! a size cap, honour cancellation, and compare against the hash listed in
//! the signature-verified `SHA256SUMS` manifest.

use std::future::Future;
use std::path::Path;
use std::time::Duration;

use ring::digest::{Context, SHA256};
use tokio::io::AsyncWriteExt;
use vst_types::rest::update::{UpdateError, UpdateReason};

use super::cancel::CancelToken;
use super::install_err;
use super::manifest::{Manifest, ManifestError, MAX_MANIFEST_BYTES};
use super::signature::{self, PinnedKey, MAX_SIG_BYTES};
use crate::update::state::AssetRef;

pub const MANIFEST_NAME: &str = "SHA256SUMS";
pub const SIG_NAME: &str = "SHA256SUMS.minisig";

/// No bytes (or response headers) for this long means the connection is dead
/// (half-open TCP after sleep / Wi-Fi change / captive portal): `offline`.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Hard ceiling for one asset download: a fixed base plus time for the listed
/// size at a pessimistic 128 KiB/s, so a trickling connection cannot hold the
/// install (and with it every restart) forever.
fn total_budget(max_size: u64) -> Duration {
    Duration::from_secs(600 + max_size / (128 * 1024))
}

fn stalled(what: &str) -> UpdateError {
    install_err(
        UpdateReason::Offline,
        format!("{what} stalled: no data received (check your connection and retry)"),
    )
}

/// Await a network step with an idle timeout, abandoning it at once when the
/// install is cancelled.
async fn guarded<T>(
    fut: impl Future<Output = Result<T, reqwest::Error>>,
    cancel: &CancelToken,
    idle: Duration,
) -> Result<T, UpdateError> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => {
            Err(install_err(UpdateReason::Cancelled, "download cancelled"))
        }
        r = tokio::time::timeout(idle, fut) => match r {
            Err(_) => Err(stalled("download")),
            Ok(Err(e)) => Err(install_err(
                UpdateReason::Offline,
                format!("download failed: {e}"),
            )),
            Ok(Ok(v)) => Ok(v),
        },
    }
}

/// Hex-encode a digest (lowercase).
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// Only `https://` URLs are allowed, except loopback hosts (tests).
fn check_url(url: &str) -> Result<(), UpdateError> {
    let parsed = reqwest::Url::parse(url).map_err(|e| {
        install_err(
            UpdateReason::GithubError,
            format!("invalid download URL: {e}"),
        )
    })?;
    let loopback = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"));
    if parsed.scheme() == "https" || (loopback && parsed.scheme() == "http") {
        Ok(())
    } else {
        Err(install_err(
            UpdateReason::GithubError,
            format!("refusing non-https download URL: {url}"),
        ))
    }
}

enum FetchErr {
    Status(u16),
    TooLarge,
    Transport(String),
}

/// GET `url`, reading at most `limit` bytes.
async fn fetch_bounded(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
    idle: Duration,
) -> Result<Vec<u8>, FetchErr> {
    let stall = || FetchErr::Transport(format!("stalled for {}s with no data", idle.as_secs()));
    let mut resp = tokio::time::timeout(idle, client.get(url).send())
        .await
        .map_err(|_| stall())?
        .map_err(|e| FetchErr::Transport(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(FetchErr::Status(resp.status().as_u16()));
    }
    let mut out = Vec::new();
    while let Some(chunk) = tokio::time::timeout(idle, resp.chunk())
        .await
        .map_err(|_| stall())?
        .map_err(|e| FetchErr::Transport(e.to_string()))?
    {
        if out.len() + chunk.len() > limit {
            return Err(FetchErr::TooLarge);
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Fetch, signature-verify, parse and version-bind the release manifest
/// (`SHA256SUMS` + `SHA256SUMS.minisig`). Fail-closed: there is no fallback
/// to per-asset `.sha256` files.
pub async fn fetch_verified_manifest(
    client: &reqwest::Client,
    assets: &[AssetRef],
    expected_version: &str,
    running: &str,
    keys: &[PinnedKey],
) -> Result<Manifest, UpdateError> {
    let find = |n: &str| assets.iter().find(|a| a.name == n);
    let (Some(man_asset), Some(sig_asset)) = (find(MANIFEST_NAME), find(SIG_NAME)) else {
        return Err(install_err(
            UpdateReason::MissingSignature,
            "this release is not signed (no SHA256SUMS / SHA256SUMS.minisig)",
        ));
    };
    check_url(&sig_asset.url)?;
    check_url(&man_asset.url)?;
    let transport = |what: &str, e: String| {
        install_err(
            UpdateReason::Offline,
            format!("could not fetch {what}: {e}"),
        )
    };
    // 404/410: the release is unsigned (asset gone). Any other status means
    // the asset is listed but GitHub failed to serve it: a transient
    // `github_error`, not a verification failure. Fail-closed either way.
    let status_err = |c: u16, absent: UpdateReason, name: &str| {
        let reason = if matches!(c, 404 | 410) {
            absent
        } else {
            UpdateReason::GithubError
        };
        install_err(reason, format!("{name} returned HTTP {c}"))
    };
    let sig_bytes = match fetch_bounded(client, &sig_asset.url, MAX_SIG_BYTES, IDLE_TIMEOUT).await {
        Ok(b) => b,
        Err(FetchErr::Status(c)) => {
            return Err(status_err(c, UpdateReason::MissingSignature, SIG_NAME))
        }
        Err(FetchErr::TooLarge) => {
            return Err(install_err(
                UpdateReason::BadSignature,
                format!("{SIG_NAME} is too large"),
            ))
        }
        Err(FetchErr::Transport(e)) => return Err(transport(SIG_NAME, e)),
    };
    let man_bytes =
        match fetch_bounded(client, &man_asset.url, MAX_MANIFEST_BYTES, IDLE_TIMEOUT).await {
            Ok(b) => b,
            Err(FetchErr::Status(c)) => {
                return Err(status_err(c, UpdateReason::MissingChecksum, MANIFEST_NAME))
            }
            Err(FetchErr::TooLarge) => {
                return Err(install_err(
                    UpdateReason::BadSignature,
                    format!("{MANIFEST_NAME} is too large"),
                ))
            }
            Err(FetchErr::Transport(e)) => return Err(transport(MANIFEST_NAME, e)),
        };
    let bad = |why: String| install_err(UpdateReason::BadSignature, why);
    let sig_str =
        String::from_utf8(sig_bytes).map_err(|_| bad(format!("{SIG_NAME} is not valid UTF-8")))?;
    signature::verify_manifest(&man_bytes, &sig_str, keys)
        .map_err(|e| bad(format!("{MANIFEST_NAME} signature check failed: {e}")))?;
    // Parse the SAME bytes that were verified.
    let manifest = Manifest::parse(&man_bytes)
        .map_err(|e| bad(format!("{MANIFEST_NAME} is malformed: {e}")))?;
    manifest
        .bind(expected_version, running)
        .map_err(|e| match e {
            ManifestError::Downgrade => install_err(
                UpdateReason::Downgrade,
                format!("signed release is not newer than the running version {running}"),
            ),
            other => bad(format!(
                "signed manifest does not match this release: {other:?}"
            )),
        })?;
    Ok(manifest)
}

/// Download `url` to `dest`, verifying it against `expected_sha256`
/// (64 lowercase hex, taken from the signed manifest).
///
/// `max_size` is the release-listed size + 1 MB. `on_progress` receives
/// 0..=100 whenever the percentage changes (only when the server reports a
/// length). On any failure the partial/mismatched file is removed.
pub async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    expected_sha256: &str,
    max_size: u64,
    dest: &Path,
    cancel: &CancelToken,
    on_progress: &(dyn Fn(u8) + Send + Sync),
) -> Result<(), UpdateError> {
    download_verified_with(
        client,
        url,
        expected_sha256,
        max_size,
        dest,
        cancel,
        on_progress,
        IDLE_TIMEOUT,
    )
    .await
}

/// [`download_verified`] with an explicit idle timeout (tests).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_verified_with(
    client: &reqwest::Client,
    url: &str,
    expected_sha256: &str,
    max_size: u64,
    dest: &Path,
    cancel: &CancelToken,
    on_progress: &(dyn Fn(u8) + Send + Sync),
    idle: Duration,
) -> Result<(), UpdateError> {
    check_url(url)?;
    prepare_dest(dest)?;
    let streamed = tokio::time::timeout(
        total_budget(max_size),
        stream_to_file(client, url, max_size, dest, cancel, on_progress, idle),
    )
    .await
    .unwrap_or_else(|_| Err(stalled("download (time budget exceeded)")));
    let result = streamed;
    let actual = match result {
        Ok(d) => d,
        Err(e) => {
            let _ = std::fs::remove_file(dest);
            return Err(e);
        }
    };
    if actual != expected_sha256 {
        let _ = std::fs::remove_file(dest);
        return Err(install_err(
            UpdateReason::ChecksumMismatch,
            "downloaded file does not match its published SHA-256 checksum",
        ));
    }
    Ok(())
}

/// Create the parent dir (0700) and remove any previous `dest`.
fn prepare_dest(dest: &Path) -> Result<(), UpdateError> {
    use std::os::unix::fs::DirBuilderExt;
    let werr = |e: std::io::Error| {
        install_err(
            super::replace::io_reason(&e),
            format!("cannot prepare download dir: {e}"),
        )
    };
    if let Some(parent) = dest.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .map_err(werr)?;
    }
    match std::fs::remove_file(dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(werr(e)),
    }
}

async fn stream_to_file(
    client: &reqwest::Client,
    url: &str,
    max_size: u64,
    dest: &Path,
    cancel: &CancelToken,
    on_progress: &(dyn Fn(u8) + Send + Sync),
    idle: Duration,
) -> Result<String, UpdateError> {
    let werr = |e: std::io::Error| {
        install_err(
            super::replace::io_reason(&e),
            format!("cannot write download: {e}"),
        )
    };
    let mut resp = guarded(client.get(url).send(), cancel, idle).await?;
    if !resp.status().is_success() {
        return Err(install_err(
            UpdateReason::GithubError,
            format!("download returned HTTP {}", resp.status().as_u16()),
        ));
    }
    let total = resp.content_length().filter(|n| *n > 0);
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(dest)
        .await
        .map_err(werr)?;
    let mut ctx = Context::new(&SHA256);
    let mut seen: u64 = 0;
    let mut last_pct: Option<u8> = None;
    while let Some(chunk) = guarded(resp.chunk(), cancel, idle).await? {
        if cancel.is_cancelled() {
            return Err(install_err(UpdateReason::Cancelled, "download cancelled"));
        }
        seen += chunk.len() as u64;
        if seen > max_size {
            return Err(install_err(
                UpdateReason::GithubError,
                "download is larger than the size listed in the release",
            ));
        }
        ctx.update(&chunk);
        file.write_all(&chunk).await.map_err(werr)?;
        if let Some(t) = total {
            let pct = u8::try_from((seen.saturating_mul(100) / t).min(100)).unwrap_or(100);
            if last_pct != Some(pct) {
                last_pct = Some(pct);
                on_progress(pct);
            }
        }
    }
    if cancel.is_cancelled() {
        return Err(install_err(UpdateReason::Cancelled, "download cancelled"));
    }
    file.flush().await.map_err(werr)?;
    Ok(hex(ctx.finish().as_ref()))
}

#[cfg(test)]
mod tests {
    use super::super::signature::test_support::{keypair_from_seed, manifest_bytes, sign_minisig};
    use super::*;
    use std::sync::Mutex as StdMutex;

    // mockito 0.31 is process-global: serialise tests (distinct path prefix too).
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    const KID: [u8; 8] = [1, 2, 3, 4, 5, 6, 7, 8];

    fn sha(data: &[u8]) -> String {
        let mut c = Context::new(&SHA256);
        c.update(data);
        hex(c.finish().as_ref())
    }

    fn asset(name: &str, url: String) -> AssetRef {
        AssetRef {
            name: name.into(),
            url,
            size: 10,
        }
    }

    /// (keys, manifest, minisig) for tag `tag` listing `a.tgz` = `body`.
    fn signed(tag: &str, body: &[u8]) -> (Vec<PinnedKey>, Vec<u8>, String) {
        let (k, kp) = keypair_from_seed([7u8; 32], KID);
        let m = manifest_bytes(tag, &[("a.tgz", body)]);
        let s = sign_minisig(&kp, KID, &m, &format!("vibe-station {tag}"));
        (vec![k], m, s)
    }

    fn release_assets(base: &str) -> Vec<AssetRef> {
        vec![
            asset("SHA256SUMS", format!("{base}/dl/SHA256SUMS")),
            asset(
                "SHA256SUMS.minisig",
                format!("{base}/dl/SHA256SUMS.minisig"),
            ),
            asset("a.tgz", format!("{base}/dl/a.tgz")),
        ]
    }

    fn serve(m: &[u8], s: &str) -> (mockito::Mock, mockito::Mock) {
        (
            mockito::mock("GET", "/dl/SHA256SUMS").with_body(m).create(),
            mockito::mock("GET", "/dl/SHA256SUMS.minisig")
                .with_body(s)
                .create(),
        )
    }

    async fn dl(
        url: &str,
        want: &str,
        max: u64,
        dest: &Path,
        cancel: bool,
    ) -> Result<(), UpdateError> {
        download_verified(
            &reqwest::Client::new(),
            url,
            want,
            max,
            dest,
            &{
                let t = CancelToken::new();
                if cancel {
                    t.cancel();
                }
                t
            },
            &|_| {},
        )
        .await
    }

    async fn manifest_for(
        assets: &[AssetRef],
        keys: &[PinnedKey],
        expected: &str,
        running: &str,
    ) -> Result<Manifest, UpdateError> {
        fetch_verified_manifest(&reqwest::Client::new(), assets, expected, running, keys).await
    }

    // 2.T1
    #[tokio::test]
    async fn signed_manifest_installs() {
        let _g = LOCK.lock().await;
        let body = vec![7u8; 4096];
        let (keys, m, s) = signed("v0.4.0", &body);
        let _mm = serve(&m, &s);
        let _a = mockito::mock("GET", "/dl/a.tgz").with_body(&body).create();
        let base = mockito::server_url();
        let man = manifest_for(&release_assets(&base), &keys, "0.4.0", "0.3.0")
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("sub/a.tgz");
        let seen = StdMutex::new(Vec::new());
        download_verified(
            &reqwest::Client::new(),
            &format!("{base}/dl/a.tgz"),
            man.sha256_of("a.tgz").unwrap(),
            5000,
            &dest,
            &CancelToken::new(),
            &|p| seen.lock().unwrap().push(p),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert_eq!(seen.lock().unwrap().last(), Some(&100));
    }

    // 2.T2
    #[tokio::test]
    async fn missing_signature_fails_closed() {
        let _g = LOCK.lock().await;
        let (keys, m, _s) = signed("v0.4.0", b"x");
        let base = mockito::server_url();
        let _mm = mockito::mock("GET", "/dl/SHA256SUMS")
            .with_body(&m)
            .create();
        let _ms = mockito::mock("GET", "/dl/SHA256SUMS.minisig")
            .with_status(404)
            .create();
        let e = manifest_for(&release_assets(&base), &keys, "0.4.0", "0.3.0")
            .await
            .unwrap_err();
        assert_eq!(e.reason, UpdateReason::MissingSignature);

        // absent from the asset list: zero network calls
        let any = mockito::mock("GET", mockito::Matcher::Regex("^/dl/".into()))
            .expect(0)
            .create();
        let mut assets = release_assets(&base);
        assets.retain(|a| a.name != "SHA256SUMS.minisig");
        let e = manifest_for(&assets, &keys, "0.4.0", "0.3.0")
            .await
            .unwrap_err();
        assert_eq!(e.reason, UpdateReason::MissingSignature);
        any.assert();
    }

    // A 5xx on an asset that IS listed is GitHub failing, not an
    // unsigned release.
    #[tokio::test]
    async fn http_500_on_signature_or_manifest_is_github_error() {
        let _g = LOCK.lock().await;
        let (keys, m, s) = signed("v0.4.0", b"x");
        let base = mockito::server_url();
        {
            let _mm = mockito::mock("GET", "/dl/SHA256SUMS")
                .with_body(&m)
                .create();
            let _ms = mockito::mock("GET", "/dl/SHA256SUMS.minisig")
                .with_status(500)
                .create();
            let e = manifest_for(&release_assets(&base), &keys, "0.4.0", "0.3.0")
                .await
                .unwrap_err();
            assert_eq!(e.reason, UpdateReason::GithubError);
            assert!(e.message.contains("HTTP 500"), "{}", e.message);
        }
        let _ms = mockito::mock("GET", "/dl/SHA256SUMS.minisig")
            .with_body(&s)
            .create();
        let _mm = mockito::mock("GET", "/dl/SHA256SUMS")
            .with_status(500)
            .create();
        let e = manifest_for(&release_assets(&base), &keys, "0.4.0", "0.3.0")
            .await
            .unwrap_err();
        assert_eq!(e.reason, UpdateReason::GithubError);
    }

    // 2.T3
    #[tokio::test]
    async fn bad_or_wrong_key_signature_fails_closed() {
        let _g = LOCK.lock().await;
        let base = mockito::server_url();
        let (keys, m, s) = signed("v0.4.0", b"x");
        // corrupted: swap the file-sig line for the global-sig line's content
        let mut lines: Vec<&str> = s.lines().collect();
        lines[1] = lines[3];
        let corrupt = lines.join("\n") + "\n";
        {
            let _mm = serve(&m, &corrupt);
            let e = manifest_for(&release_assets(&base), &keys, "0.4.0", "0.3.0")
                .await
                .unwrap_err();
            assert_eq!(e.reason, UpdateReason::BadSignature);
        }
        // signed by a key not pinned
        let (other, _) = keypair_from_seed([9u8; 32], [9; 8]);
        let _mm = serve(&m, &s);
        let e = manifest_for(&release_assets(&base), &[other], "0.4.0", "0.3.0")
            .await
            .unwrap_err();
        assert_eq!(e.reason, UpdateReason::BadSignature);
    }

    // 2.T4
    #[tokio::test]
    async fn hash_mismatch_after_valid_sig() {
        let _g = LOCK.lock().await;
        let base = mockito::server_url();
        let (keys, m, s) = signed("v0.4.0", b"genuine");
        let _mm = serve(&m, &s);
        let _a = mockito::mock("GET", "/dl/a.tgz")
            .with_body("tampered")
            .create();
        let man = manifest_for(&release_assets(&base), &keys, "0.4.0", "0.3.0")
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.tgz");
        let e = dl(
            &format!("{base}/dl/a.tgz"),
            man.sha256_of("a.tgz").unwrap(),
            100,
            &dest,
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(e.reason, UpdateReason::ChecksumMismatch);
        assert!(!dest.exists());
    }

    // 2.T5
    #[tokio::test]
    async fn downgrade_and_replay_rejected() {
        let _g = LOCK.lock().await;
        let base = mockito::server_url();
        let (keys, m, s) = signed("v0.2.0", b"x");
        {
            let _mm = serve(&m, &s);
            let e = manifest_for(&release_assets(&base), &keys, "0.2.0", "0.3.0")
                .await
                .unwrap_err();
            assert_eq!(e.reason, UpdateReason::Downgrade);
        }
        let (keys, m, s) = signed("v0.3.0", b"x");
        let _mm = serve(&m, &s);
        let e = manifest_for(&release_assets(&base), &keys, "0.4.0", "0.3.0")
            .await
            .unwrap_err();
        assert_eq!(e.reason, UpdateReason::BadSignature);
    }

    // 2.T6
    #[tokio::test]
    async fn oversized_or_unreachable() {
        let _g = LOCK.lock().await;
        let base = mockito::server_url();
        let (keys, m, s) = signed("v0.4.0", b"x");
        {
            let big = vec![b'#'; MAX_MANIFEST_BYTES + 1];
            let _mm = serve(&big, &s);
            let e = manifest_for(&release_assets(&base), &keys, "0.4.0", "0.3.0")
                .await
                .unwrap_err();
            assert_eq!(e.reason, UpdateReason::BadSignature);
        }
        {
            let big = "a".repeat(MAX_SIG_BYTES + 1);
            let _mm = serve(&m, &big);
            let e = manifest_for(&release_assets(&base), &keys, "0.4.0", "0.3.0")
                .await
                .unwrap_err();
            assert_eq!(e.reason, UpdateReason::BadSignature);
        }
        let dead = vec![
            asset("SHA256SUMS", "http://127.0.0.1:9/SHA256SUMS".into()),
            asset(
                "SHA256SUMS.minisig",
                "http://127.0.0.1:9/SHA256SUMS.minisig".into(),
            ),
        ];
        let e = manifest_for(&dead, &keys, "0.4.0", "0.3.0")
            .await
            .unwrap_err();
        assert_eq!(e.reason, UpdateReason::Offline);
    }

    #[tokio::test]
    async fn cancel_deletes_partial() {
        let _g = LOCK.lock().await;
        let body = vec![1u8; 2048];
        let _a = mockito::mock("GET", "/dl/c.tgz").with_body(&body).create();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("c.tgz");
        let base = mockito::server_url();
        let e = dl(&format!("{base}/dl/c.tgz"), &sha(&body), 5000, &dest, true)
            .await
            .unwrap_err();
        assert_eq!(e.reason, UpdateReason::Cancelled);
        assert!(!dest.exists());
    }

    /// Raw server: answers with headers + one chunk, then stalls forever.
    async fn stalling_server() -> String {
        use tokio::io::AsyncWriteExt;
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = l.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
                    let _ = sock
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n")
                        .await;
                    let _ = sock.write_all(&[7u8; 1000]).await;
                    let _ = sock.flush().await;
                    tokio::time::sleep(Duration::from_secs(3600)).await;
                    drop(sock);
                });
            }
        });
        format!("http://{addr}/a.bin")
    }

    #[tokio::test]
    async fn stalled_download_is_cancelled_promptly() {
        let url = stalling_server().await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.bin");
        let token = std::sync::Arc::new(CancelToken::new());
        let t2 = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            t2.cancel();
        });
        let started = std::time::Instant::now();
        let e = download_verified(
            &reqwest::Client::new(),
            &url,
            &"0".repeat(64),
            2_000_000,
            &dest,
            &token,
            &|_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(e.reason, UpdateReason::Cancelled);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
        assert!(!dest.exists(), "partial file removed");
    }

    #[tokio::test]
    async fn stalled_download_without_cancel_is_offline_after_idle_timeout() {
        let url = stalling_server().await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.bin");
        let started = std::time::Instant::now();
        let e = download_verified_with(
            &reqwest::Client::new(),
            &url,
            &"0".repeat(64),
            2_000_000,
            &dest,
            &CancelToken::new(),
            &|_| {},
            Duration::from_millis(400),
        )
        .await
        .unwrap_err();
        assert_eq!(e.reason, UpdateReason::Offline);
        assert!(e.message.contains("stalled"), "{}", e.message);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!dest.exists());
    }

    #[tokio::test]
    async fn stalled_manifest_fetch_times_out() {
        let url = stalling_server().await;
        let r = fetch_bounded(
            &reqwest::Client::new(),
            &url,
            10_000_000,
            Duration::from_millis(300),
        )
        .await;
        assert!(matches!(r, Err(FetchErr::Transport(m)) if m.contains("stalled")));
    }

    #[tokio::test]
    async fn oversize_aborts_and_non_https_rejected() {
        let _g = LOCK.lock().await;
        let body = vec![1u8; 2048];
        let _a = mockito::mock("GET", "/dl/o.tgz").with_body(&body).create();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("o.tgz");
        let base = mockito::server_url();
        let e = dl(&format!("{base}/dl/o.tgz"), &sha(&body), 100, &dest, false)
            .await
            .unwrap_err();
        assert_eq!(e.kind, vst_types::rest::update::UpdateErrorKind::Install);
        assert!(!dest.exists());
        let e = dl("http://example.com/x", &sha(&body), 100, &dest, false)
            .await
            .unwrap_err();
        assert!(e.message.contains("non-https"));
    }
}
