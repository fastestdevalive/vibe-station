//! HTTP-level tests for the wallpaper routes (`GET /api/wallpapers`,
//! `GET /api/wallpapers/:id/image`): catalog shape, sizes, ETag/304, error
//! codes and the "no client-supplied URL" rule (plan 2.B.5).
//!
//! Real router driven with `oneshot`; no TCP port is bound and no upstream CDN
//! is touched — a fake [`ImageFetcher`] stands in for the network.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::Router;
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;

use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_state, router_from_state, BuildServerOptions};
use vst_git::paths::Paths;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::rest::wallpapers::WallpaperCatalogResponse;
use vst_wallpapers::{Catalog, FetchError, FetchedImage, ImageFetcher, WallpaperHandle};

const IMAGE_BYTES: &[u8] = b"\xFF\xD8\xFF\xE0 fake-jpeg-for-tests";

/// Records every URL it is asked for; either serves fixed bytes or fails with
/// a non-2xx status, so the handle's backoff path is exercised too.
struct FakeFetcher {
    calls: Arc<Mutex<Vec<String>>>,
    fail: bool,
    bytes: Arc<Vec<u8>>,
}

impl ImageFetcher for FakeFetcher {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
        _max_bytes: u64,
    ) -> Pin<Box<dyn Future<Output = Result<FetchedImage, FetchError>> + Send + 'a>> {
        self.calls.lock().unwrap().push(url.to_string());
        let fail = self.fail;
        let bytes = self.bytes.clone();
        Box::pin(async move {
            if fail {
                return Err(FetchError::Status(500));
            }
            Ok(FetchedImage {
                bytes: bytes.as_ref().clone(),
                content_type: "image/jpeg".into(),
            })
        })
    }
}

struct H {
    _tmp: TempDir,
    router: Router,
    calls: Arc<Mutex<Vec<String>>>,
}

impl H {
    fn new(fail: bool) -> H {
        let tmp = tempfile::tempdir().unwrap();
        let vst_home = tmp.path().join("home").join(".vibe-station");
        std::fs::create_dir_all(&vst_home).unwrap();
        let paths = Paths::with_home(vst_home);
        let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
        let state = build_state(BuildServerOptions {
            network: NetworkControl::fixed(false),
            port: 0,
            auth_state: None,
            no_auth: true,
            stop_requested: Arc::new(tokio::sync::Notify::new()),
            dist_path: None,
            persist_epoch: None,
            store,
            broadcaster: Broadcaster::new(16),
            json_registry: Arc::new(vst_agents::json_agent_registry::JsonAgentRegistry::<
                vst_agents::json_agent_session::JsonAgentSession,
            >::new()),
            tmux: vst_proc::test_support::isolated_tmux(),
            started_at: Instant::now(),
            version: "test".into(),
            update: vst_daemon::update::UpdateService::for_tests(paths.vst_home()),
            paths,
            limits: vst_harness_limits::LimitsHandle::inert(Broadcaster::new(16), "test".into()),
        });

        let calls = Arc::new(Mutex::new(Vec::new()));
        let fetcher = Arc::new(FakeFetcher {
            calls: calls.clone(),
            fail,
            bytes: Arc::new(IMAGE_BYTES.to_vec()),
        });
        let handle = WallpaperHandle::with_catalog(
            tmp.path().join("wallpaper-cache"),
            fetcher,
            Catalog::bundled().expect("bundled catalog"),
        );
        let router = router_from_state(state.with_wallpapers(handle));

        H {
            _tmp: tmp,
            router,
            calls,
        }
    }

    async fn get(&self, uri: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
        self.get_with(uri, &[]).await
    }

    async fn get_with(
        &self,
        uri: &str,
        extra: &[(&str, &str)],
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut builder = Request::builder().uri(uri).method(Method::GET);
        for (name, value) in extra {
            builder = builder.header(*name, *value);
        }
        let response = self
            .router
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        (status, headers, bytes)
    }

    fn called_urls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

fn header(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .unwrap_or_else(|| panic!("missing header {name}"))
        .to_str()
        .unwrap()
        .to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
    digest.as_ref().iter().fold(String::new(), |mut out, byte| {
        // Writing hex into a `String` cannot fail.
        let _ = std::fmt::Write::write_fmt(&mut out, format_args!("{byte:02x}"));
        out
    })
}

fn json_body(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}

#[tokio::test]
async fn catalog_lists_31_under_api() {
    let h = H::new(false);
    let (status, headers, body) = h.get("/api/wallpapers").await;
    assert_eq!(status, StatusCode::OK);
    assert!(header(&headers, "content-type").starts_with("application/json"));
    let catalog: WallpaperCatalogResponse = serde_json::from_slice(&body).unwrap();
    assert_eq!(catalog.version, 1);
    assert_eq!(catalog.wallpapers.len(), 31);
    assert_eq!(catalog.wallpapers[0].id, "wp-001");
    assert_eq!(catalog.wallpapers[30].id, "wp-031");
    assert_eq!(h.called_urls().len(), 0, "listing must not fetch images");
}

#[tokio::test]
async fn root_path_without_api_prefix_is_not_the_route() {
    let h = H::new(false);
    let (status, _, body) = h.get("/wallpapers").await;
    // The daemon nests every REST route under `/api`; an unprefixed path falls
    // through to the SPA fallback, never the catalog handler.
    assert!(
        serde_json::from_slice::<WallpaperCatalogResponse>(&body).is_err(),
        "GET /wallpapers must not serve the catalog"
    );
    assert_ne!(status, StatusCode::OK);
}

#[tokio::test]
async fn image_full_returns_bytes_with_etag() {
    let h = H::new(false);
    let (status, headers, body) = h.get("/api/wallpapers/wp-001/image?size=full").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, IMAGE_BYTES);
    assert_eq!(header(&headers, "content-type"), "image/jpeg");
    assert_eq!(
        header(&headers, "etag"),
        format!("\"{}\"", sha256_hex(IMAGE_BYTES))
    );
    assert_eq!(header(&headers, "cache-control"), "private, max-age=86400");
    assert_eq!(
        header(&headers, "content-security-policy"),
        "default-src 'none'; sandbox"
    );
    assert_eq!(header(&headers, "x-content-type-options"), "nosniff");
    let entry = Catalog::bundled().unwrap();
    let url = entry.url_for("wp-001", vst_wallpapers::ImageSize::Full);
    assert_eq!(h.called_urls(), vec![url.unwrap().to_string()]);
}

#[tokio::test]
async fn image_default_size_is_full() {
    let h = H::new(false);
    let (status, _, body) = h.get("/api/wallpapers/wp-002/image").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, IMAGE_BYTES);
    let entry = Catalog::bundled().unwrap();
    let url = entry.url_for("wp-002", vst_wallpapers::ImageSize::Full);
    assert_eq!(h.called_urls(), vec![url.unwrap().to_string()]);
}

#[tokio::test]
async fn image_thumb_uses_thumbnail_url() {
    let catalog = Catalog::bundled().unwrap();
    let entry = catalog
        .response()
        .wallpapers
        .iter()
        .find(|e| e.thumbnail_url != e.url)
        .expect("the bundled catalog has at least one distinct thumbnail");
    let h = H::new(false);
    let (status, _, body) = h
        .get(&format!("/api/wallpapers/{}/image?size=thumb", entry.id))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, IMAGE_BYTES);
    assert_eq!(h.called_urls(), vec![entry.thumbnail_url.clone()]);
}

#[tokio::test]
async fn if_none_match_returns_304() {
    let h = H::new(false);
    let uri = "/api/wallpapers/wp-003/image?size=full";
    let (status, headers, _) = h.get(uri).await;
    assert_eq!(status, StatusCode::OK);
    let etag = header(&headers, "etag");

    let (status, headers, body) = h.get_with(uri, &[("if-none-match", &etag)]).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert_eq!(header(&headers, "etag"), etag);
    assert_eq!(header(&headers, "cache-control"), "private, max-age=86400");
    assert_eq!(body.len(), 0, "304 must have an empty body");

    // Weak validators compare equal for If-None-Match (RFC 9110).
    let (status, _, body) = h
        .get_with(uri, &[("if-none-match", &format!("W/{etag}"))])
        .await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert_eq!(body.len(), 0, "304 must have an empty body");
    assert_eq!(h.called_urls().len(), 1, "304 must not refetch");
}

#[tokio::test]
async fn unknown_id_404_code() {
    let h = H::new(false);
    let (status, _, body) = h.get("/api/wallpapers/wp-999/image?size=full").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let body = json_body(&body);
    assert_eq!(body["error"], "WALLPAPER_NOT_FOUND");
    assert!(body["message"].is_string());
    assert_eq!(h.called_urls().len(), 0, "unknown id must not fetch");
}

#[tokio::test]
async fn bad_size_400_validation_error() {
    let h = H::new(false);
    let (status, _, body) = h.get("/api/wallpapers/wp-001/image?size=huge").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let body = json_body(&body);
    assert_eq!(body["error"], "VALIDATION_ERROR");
    assert_eq!(h.called_urls().len(), 0, "no image fetch expected");
}

#[tokio::test]
async fn upstream_failure_502_then_503_with_retry_after() {
    let h = H::new(true);
    let uri = "/api/wallpapers/wp-001/image?size=full";

    let (status, _, body) = h.get(uri).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(json_body(&body)["error"], "WALLPAPER_UNAVAILABLE");

    let (status, headers, body) = h.get(uri).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json_body(&body)["error"], "WALLPAPER_BACKING_OFF");
    let retry_after: u64 = header(&headers, "retry-after").parse().unwrap();
    assert!(
        retry_after >= 1,
        "Retry-After must be a positive seconds value"
    );
    assert_eq!(h.called_urls().len(), 1, "backoff must not refetch");
}

#[tokio::test]
async fn no_client_supplied_url_is_accepted() {
    let h = H::new(false);
    let (status, _, body) = h
        .get("/api/wallpapers/wp-001/image?size=full&url=http://evil.example/x.jpg")
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, IMAGE_BYTES);
    let entry = Catalog::bundled().unwrap();
    let url = entry.url_for("wp-001", vst_wallpapers::ImageSize::Full);
    assert_eq!(
        h.called_urls(),
        vec![url.unwrap().to_string()],
        "the fetcher only ever sees catalog URLs"
    );
}
