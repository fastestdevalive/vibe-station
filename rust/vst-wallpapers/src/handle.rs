//! `WallpaperHandle` — the single owner of "id + size → served image bytes".
//!
//! One `Arc<Inner>` holds the bundled catalog, the disk cache, the injected
//! fetcher and the two pieces of mutable bookkeeping: a per-`(id,size)` single
//! flight lock and a per-`(id,size)` backoff memo. A cache hit never touches the
//! network; a failed fetch backs off with an exponential delay so a broken
//! upstream is not hammered by every connected client.
//!
//! Time comes from `tokio::time::Instant` so tests can pause and advance the
//! clock instead of sleeping through a real backoff window.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Mutex as AsyncMutex;
use tokio::time::Instant;
use tracing::warn;
use vst_types::rest::wallpapers::WallpaperCatalogResponse;

use crate::cache::{CachedFile, DiskCache};
use crate::catalog::{Catalog, CatalogError, ImageSize};
use crate::fetcher::ImageFetcher;

/// Largest thumbnail body accepted from upstream.
pub const THUMB_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Largest full-size body accepted from upstream.
pub const FULL_MAX_BYTES: u64 = 12 * 1024 * 1024;

/// First backoff step; doubles per consecutive failure.
const BACKOFF_BASE_SECS: u64 = 5;
/// Backoff ceiling.
const BACKOFF_MAX_SECS: u64 = 300;

/// One image ready to be served: bytes, their type, and the quoted sha256 `ETag`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServedImage {
    pub bytes: Arc<Vec<u8>>,
    pub content_type: String,
    /// Quoted sha256 hex of `bytes` (`"<hex>"`).
    pub etag: String,
}

/// Why an image could not be served. `Unavailable` carries the upstream failure
/// kind only — never a URL.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ImageError {
    #[error("unknown wallpaper id")]
    UnknownId,
    #[error("wallpaper image unavailable: {0}")]
    Unavailable(String),
    #[error("wallpaper source is backing off")]
    BackingOff { retry_after_secs: u64 },
}

/// Per-`(id,size)` consecutive-failure state.
#[derive(Clone, Copy, Debug)]
struct BackoffEntry {
    failures: u32,
    retry_at: Instant,
}

/// Everything the handle owns. All state lives here so the handle itself is a
/// cheap `Clone` (`AppState` is `#[derive(Clone)]`).
struct Inner {
    catalog: Catalog,
    cache: DiskCache,
    fetcher: Arc<dyn ImageFetcher>,
    /// One async mutex per `(id,size)`: a second caller waits, then re-checks
    /// the disk instead of fetching the same image again.
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    backoff: Mutex<HashMap<String, BackoffEntry>>,
}

/// The wallpaper catalog plus its image cache and bounded fetcher.
#[derive(Clone)]
pub struct WallpaperHandle {
    inner: Arc<Inner>,
}

impl WallpaperHandle {
    /// Build a handle around the bundled catalog.
    ///
    /// # Errors
    /// `CatalogError` when the bundled snapshot fails validation (a broken
    /// build — the snapshot is `include_str!` data guarded by unit tests).
    pub fn new(cache_dir: PathBuf, fetcher: Arc<dyn ImageFetcher>) -> Result<Self, CatalogError> {
        Ok(Self::with_catalog(cache_dir, fetcher, Catalog::bundled()?))
    }

    /// Build a handle around an explicit catalog (tests, tooling).
    #[must_use]
    pub fn with_catalog(
        cache_dir: PathBuf,
        fetcher: Arc<dyn ImageFetcher>,
        catalog: Catalog,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                catalog,
                cache: DiskCache::new(cache_dir),
                fetcher,
                locks: Mutex::new(HashMap::new()),
                backoff: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// The catalog served by `GET /api/wallpapers`.
    #[must_use]
    pub fn catalog(&self) -> &WallpaperCatalogResponse {
        self.inner.catalog.response()
    }

    /// Serve `id` at `size`, from the disk cache when possible.
    ///
    /// # Errors
    /// `UnknownId` for an id outside the catalog (a client URL is never used),
    /// `BackingOff` while a previous failure's delay is still running, and
    /// `Unavailable` for a fetch that just failed.
    pub async fn image(&self, id: &str, size: ImageSize) -> Result<ServedImage, ImageError> {
        let Some(url) = self.inner.catalog.url_for(id, size) else {
            return Err(ImageError::UnknownId);
        };
        let url = url.to_owned();
        let key = format!("{id}-{size}");

        // The whole check-fetch-store sequence runs under this key's lock, so a
        // burst of identical requests produces exactly one upstream fetch.
        let lock = self.key_lock(&key);
        let _guard = lock.lock().await;

        let cache = self.inner.cache.clone();
        let k = key.clone();
        let hit = tokio::task::spawn_blocking(move || cache.get(&k))
            .await
            .ok()
            .flatten();
        if let Some(hit) = hit {
            return Ok(served_from(hit));
        }
        if let Some(retry_after_secs) = self.backoff_remaining(&key) {
            return Err(ImageError::BackingOff { retry_after_secs });
        }

        let cap = match size {
            ImageSize::Thumb => THUMB_MAX_BYTES,
            ImageSize::Full => FULL_MAX_BYTES,
        };
        match self.inner.fetcher.fetch(&url, cap).await {
            Ok(image) => {
                let cache = self.inner.cache.clone();
                let (k, ct) = (key.clone(), image.content_type.clone());
                let cached = tokio::task::spawn_blocking(move || cache.put(&k, image.bytes, &ct))
                    .await
                    .map_err(|e| ImageError::Unavailable(format!("cache task failed: {e}")))?;
                self.clear_backoff(&key);
                Ok(served_from(cached))
            }
            Err(error) => {
                warn!(id, size = size.as_str(), error = %error, "wallpaper image fetch failed");
                self.record_failure(&key);
                Err(ImageError::Unavailable(error.to_string()))
            }
        }
    }

    fn key_lock(&self, key: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self.locks_guard();
        locks
            .entry(key.to_owned())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    /// Seconds left in the backoff window, or `None` when a fetch may proceed.
    fn backoff_remaining(&self, key: &str) -> Option<u64> {
        let backoff = self.backoff_guard();
        let entry = backoff.get(key)?;
        let now = Instant::now();
        if now >= entry.retry_at {
            return None;
        }
        let remaining = entry.retry_at - now;
        Some(remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0))
    }

    fn record_failure(&self, key: &str) {
        let mut backoff = self.backoff_guard();
        let now = Instant::now();
        let entry = backoff.entry(key.to_owned()).or_insert(BackoffEntry {
            failures: 0,
            retry_at: now,
        });
        entry.failures = entry.failures.saturating_add(1);
        entry.retry_at = now + backoff_delay(entry.failures);
    }

    fn clear_backoff(&self, key: &str) {
        self.backoff_guard().remove(key);
    }

    fn locks_guard(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AsyncMutex<()>>>> {
        self.inner
            .locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn backoff_guard(&self) -> std::sync::MutexGuard<'_, HashMap<String, BackoffEntry>> {
        self.inner
            .backoff
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// `5s * 2^(n-1)`, capped at 5 minutes. `failures` is at least 1 when called.
fn backoff_delay(failures: u32) -> Duration {
    let shift = failures.saturating_sub(1).min(6);
    let secs = BACKOFF_BASE_SECS
        .saturating_mul(1u64 << shift)
        .min(BACKOFF_MAX_SECS);
    Duration::from_secs(secs)
}

fn served_from(cached: CachedFile) -> ServedImage {
    ServedImage {
        bytes: cached.bytes,
        content_type: cached.content_type,
        etag: format!("\"{}\"", cached.sha256_hex),
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;
    use crate::catalog::HOST_ALLOWLIST;
    use crate::fetcher::{FetchError, FetchedImage};

    const IMAGE_BYTES: &[u8] = b"fake image bytes";

    /// What the fake fetcher should answer with next.
    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Plan {
        Ok,
        Fail(FetchError),
    }

    /// A fetcher that counts calls, records the URL and cap it was given, and
    /// answers from a swappable plan.
    struct FakeFetcher {
        calls: AtomicUsize,
        urls: Mutex<Vec<String>>,
        caps: Mutex<Vec<u64>>,
        plan: Mutex<Plan>,
        delay: Duration,
    }

    impl FakeFetcher {
        fn new(plan: Plan) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                urls: Mutex::new(Vec::new()),
                caps: Mutex::new(Vec::new()),
                plan: Mutex::new(plan),
                delay: Duration::ZERO,
            }
        }

        fn with_delay(plan: Plan, delay: Duration) -> Self {
            Self {
                delay,
                ..Self::new(plan)
            }
        }

        fn set_plan(&self, plan: Plan) {
            *self.plan.lock().unwrap() = plan;
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn urls(&self) -> Vec<String> {
            self.urls.lock().unwrap().clone()
        }

        fn caps(&self) -> Vec<u64> {
            self.caps.lock().unwrap().clone()
        }
    }

    impl ImageFetcher for FakeFetcher {
        fn fetch<'a>(
            &'a self,
            url: &'a str,
            max_bytes: u64,
        ) -> Pin<Box<dyn Future<Output = Result<FetchedImage, FetchError>> + Send + 'a>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.urls.lock().unwrap().push(url.to_owned());
                self.caps.lock().unwrap().push(max_bytes);
                if !self.delay.is_zero() {
                    tokio::time::sleep(self.delay).await;
                }
                match self.plan.lock().unwrap().clone() {
                    Plan::Ok => Ok(FetchedImage {
                        bytes: IMAGE_BYTES.to_vec(),
                        content_type: "image/jpeg".to_owned(),
                    }),
                    Plan::Fail(error) => Err(error),
                }
            })
        }
    }

    /// A fetcher that must never be reached: the image is already on disk.
    struct PanicFetcher;

    impl ImageFetcher for PanicFetcher {
        fn fetch<'a>(
            &'a self,
            _url: &'a str,
            _max_bytes: u64,
        ) -> Pin<Box<dyn Future<Output = Result<FetchedImage, FetchError>> + Send + 'a>> {
            Box::pin(async { panic!("fetcher must not be called: the image is cached") })
        }
    }

    fn catalog() -> Catalog {
        Catalog::bundled().expect("bundled catalog is valid")
    }

    fn handle(dir: &std::path::Path, fetcher: Arc<dyn ImageFetcher>) -> WallpaperHandle {
        WallpaperHandle::with_catalog(dir.to_path_buf(), fetcher, catalog())
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        use std::fmt::Write as _;

        let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
        digest.as_ref().iter().fold(String::new(), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
    }

    #[tokio::test]
    async fn unknown_id_never_calls_fetcher() {
        let tmp = tempfile::tempdir().unwrap();
        let fetcher = Arc::new(FakeFetcher::new(Plan::Ok));
        let handle = handle(tmp.path(), fetcher.clone());

        for id in ["wp-999", "nonsense", ""] {
            assert_eq!(
                handle.image(id, ImageSize::Full).await,
                Err(ImageError::UnknownId),
                "{id:?} must be unknown"
            );
            assert_eq!(
                handle.image(id, ImageSize::Thumb).await,
                Err(ImageError::UnknownId)
            );
        }
        assert_eq!(fetcher.calls(), 0);
    }

    #[tokio::test]
    async fn fetches_url_from_catalog_only() {
        let tmp = tempfile::tempdir().unwrap();
        let fetcher = Arc::new(FakeFetcher::new(Plan::Ok));
        let handle = handle(tmp.path(), fetcher.clone());

        let image = handle.image("wp-001", ImageSize::Full).await.unwrap();
        assert_eq!(image.bytes.as_slice(), IMAGE_BYTES);
        assert_eq!(image.content_type, "image/jpeg");

        let expected = catalog()
            .url_for("wp-001", ImageSize::Full)
            .expect("wp-001 is in the catalog")
            .to_owned();
        assert_eq!(fetcher.urls(), vec![expected.clone()]);
        assert_eq!(fetcher.calls(), 1);

        let url = reqwest::Url::parse(&expected).unwrap();
        assert_eq!(url.scheme(), "https");
        let host = url.host_str().expect("catalog URL has a host");
        assert!(HOST_ALLOWLIST.contains(&host), "host {host}");
    }

    #[tokio::test]
    async fn second_call_is_a_disk_hit() {
        let tmp = tempfile::tempdir().unwrap();
        let fetcher = Arc::new(FakeFetcher::new(Plan::Ok));
        let handle = handle(tmp.path(), fetcher.clone());

        let first = handle.image("wp-002", ImageSize::Full).await.unwrap();
        let second = handle.image("wp-002", ImageSize::Full).await.unwrap();
        assert_eq!(first, second);
        assert_eq!(fetcher.calls(), 1);
    }

    #[tokio::test]
    async fn concurrent_calls_fetch_once() {
        let tmp = tempfile::tempdir().unwrap();
        let fetcher = Arc::new(FakeFetcher::with_delay(Plan::Ok, Duration::from_millis(10)));
        let handle = handle(tmp.path(), fetcher.clone());

        let mut tasks = Vec::new();
        for _ in 0..8 {
            let handle = handle.clone();
            tasks.push(tokio::spawn(async move {
                handle.image("wp-003", ImageSize::Full).await
            }));
        }
        for task in tasks {
            let image = task.await.unwrap().unwrap();
            assert_eq!(image.bytes.as_slice(), IMAGE_BYTES);
        }
        assert_eq!(fetcher.calls(), 1);
    }

    #[tokio::test]
    async fn thumb_and_full_cached_separately() {
        let tmp = tempfile::tempdir().unwrap();
        let fetcher = Arc::new(FakeFetcher::new(Plan::Ok));
        let handle = handle(tmp.path(), fetcher.clone());
        let catalog = catalog();
        let entry = catalog.get("wp-004").expect("wp-004 is in the catalog");

        handle.image("wp-004", ImageSize::Thumb).await.unwrap();
        handle.image("wp-004", ImageSize::Full).await.unwrap();
        assert_eq!(
            fetcher.urls(),
            vec![entry.thumbnail_url.clone(), entry.url.clone()]
        );
        assert_eq!(fetcher.calls(), 2);
        assert_eq!(fetcher.caps(), vec![THUMB_MAX_BYTES, FULL_MAX_BYTES]);

        // Both sizes are now served from their own cache entry.
        handle.image("wp-004", ImageSize::Thumb).await.unwrap();
        handle.image("wp-004", ImageSize::Full).await.unwrap();
        assert_eq!(fetcher.calls(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn failure_then_backing_off_without_fetch() {
        let tmp = tempfile::tempdir().unwrap();
        let fetcher = Arc::new(FakeFetcher::new(Plan::Fail(FetchError::Status(503))));
        let handle = handle(tmp.path(), fetcher.clone());

        let first = handle.image("wp-005", ImageSize::Full).await;
        assert!(
            matches!(first, Err(ImageError::Unavailable(_))),
            "{first:?}"
        );
        assert_eq!(fetcher.calls(), 1);

        let second = handle.image("wp-005", ImageSize::Full).await;
        match second {
            Err(ImageError::BackingOff { retry_after_secs }) => {
                assert!((1..=5).contains(&retry_after_secs), "{retry_after_secs}");
            }
            other => panic!("expected BackingOff, got {other:?}"),
        }
        assert_eq!(fetcher.calls(), 1, "backoff must not fetch");
    }

    #[tokio::test(start_paused = true)]
    async fn backoff_expires_and_retries() {
        let tmp = tempfile::tempdir().unwrap();
        let fetcher = Arc::new(FakeFetcher::new(Plan::Fail(FetchError::Timeout)));
        let handle = handle(tmp.path(), fetcher.clone());

        assert!(matches!(
            handle.image("wp-006", ImageSize::Full).await,
            Err(ImageError::Unavailable(_))
        ));
        assert!(matches!(
            handle.image("wp-006", ImageSize::Full).await,
            Err(ImageError::BackingOff { .. })
        ));

        tokio::time::advance(Duration::from_secs(BACKOFF_BASE_SECS)).await;
        fetcher.set_plan(Plan::Ok);
        let image = handle.image("wp-006", ImageSize::Full).await.unwrap();
        assert_eq!(image.bytes.as_slice(), IMAGE_BYTES);
        assert_eq!(fetcher.calls(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn success_clears_backoff() {
        let tmp = tempfile::tempdir().unwrap();
        let fetcher = Arc::new(FakeFetcher::new(Plan::Fail(FetchError::Status(500))));
        let handle = handle(tmp.path(), fetcher.clone());

        assert!(matches!(
            handle.image("wp-007", ImageSize::Full).await,
            Err(ImageError::Unavailable(_))
        ));
        assert!(matches!(
            handle.image("wp-007", ImageSize::Full).await,
            Err(ImageError::BackingOff { .. })
        ));

        tokio::time::advance(Duration::from_secs(BACKOFF_BASE_SECS)).await;
        fetcher.set_plan(Plan::Ok);
        handle.image("wp-007", ImageSize::Full).await.unwrap();
        assert_eq!(fetcher.calls(), 2);

        // Drop the cache entry (eviction / corruption is a miss) so the same
        // key fetches again: the ladder must start over at its first step
        // rather than continuing from the failures before the success.
        std::fs::remove_file(tmp.path().join("wp-007-full.img")).unwrap();
        std::fs::remove_file(tmp.path().join("wp-007-full.json")).unwrap();
        fetcher.set_plan(Plan::Fail(FetchError::Status(500)));

        assert!(matches!(
            handle.image("wp-007", ImageSize::Full).await,
            Err(ImageError::Unavailable(_))
        ));
        assert_eq!(fetcher.calls(), 3);
        match handle.image("wp-007", ImageSize::Full).await {
            Err(ImageError::BackingOff { retry_after_secs }) => assert_eq!(
                retry_after_secs, BACKOFF_BASE_SECS,
                "a success must reset the backoff ladder"
            ),
            other => panic!("expected BackingOff, got {other:?}"),
        }
        assert_eq!(fetcher.calls(), 3);
    }

    #[tokio::test]
    async fn restart_with_same_dir_serves_from_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let fetcher = Arc::new(FakeFetcher::new(Plan::Ok));
        {
            let handle = handle(tmp.path(), fetcher.clone());
            handle.image("wp-008", ImageSize::Full).await.unwrap();
        }
        assert_eq!(fetcher.calls(), 1);

        let restarted = handle(tmp.path(), Arc::new(PanicFetcher));
        let image = restarted.image("wp-008", ImageSize::Full).await.unwrap();
        assert_eq!(image.bytes.as_slice(), IMAGE_BYTES);
        assert_eq!(image.content_type, "image/jpeg");
    }

    #[tokio::test]
    async fn etag_is_quoted_sha256_of_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let fetcher = Arc::new(FakeFetcher::new(Plan::Ok));
        let handle = handle(tmp.path(), fetcher.clone());

        let image = handle.image("wp-009", ImageSize::Full).await.unwrap();
        assert!(image.etag.starts_with('"'), "{}", image.etag);
        assert!(image.etag.ends_with('"'), "{}", image.etag);
        let hex = &image.etag[1..image.etag.len() - 1];
        assert_eq!(hex, sha256_hex(IMAGE_BYTES));
        assert_eq!(hex.len(), 64);
        assert!(hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }

    #[tokio::test]
    async fn wp012_uses_its_own_hotlink_url() {
        let tmp = tempfile::tempdir().unwrap();
        let fetcher = Arc::new(FakeFetcher::new(Plan::Ok));
        let handle = handle(tmp.path(), fetcher.clone());
        let catalog = catalog();
        let entry = catalog.get("wp-012").expect("wp-012 is in the catalog");

        // wp-012 has no separate thumbnail: both sizes are the same hotlink.
        assert_eq!(entry.url, entry.thumbnail_url);
        assert_eq!(
            reqwest::Url::parse(&entry.url).unwrap().host_str(),
            Some("images.rawpixel.com")
        );

        handle.image("wp-012", ImageSize::Full).await.unwrap();
        assert_eq!(fetcher.urls(), vec![entry.url.clone()]);
    }
}
