//! Bounded, allowlisted image fetch.
//!
//! The daemon only ever fetches a URL taken from its own bundled catalog (a
//! client never supplies one), so the job here is to keep that fetch bounded:
//! https + host allowlist (re-checked on every redirect hop), a hard timeout, a
//! streaming size cap, and an `image/*` content-type check.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::{Client, Url};

/// Redirect hops followed at most before the fetch is refused.
const MAX_REDIRECTS: usize = 3;

/// Fixed User-Agent; the daemon identifies itself, it does not impersonate.
const USER_AGENT: &str = "vibe-station";

/// Allowed raster image content types. Executable formats like SVG are
/// rejected to prevent script execution in the serving origin.
const ALLOWED_TYPES: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/avif",
    "image/gif",
];

/// Image bytes plus the upstream content type they came with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchedImage {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

/// Every way a bounded fetch can fail. The handle turns these into a backoff
/// memo and a `WALLPAPER_UNAVAILABLE` reply; nothing is retried here.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum FetchError {
    #[error("request timed out")]
    Timeout,
    #[error("image exceeds the size cap")]
    TooLarge,
    #[error("unexpected content type: {0}")]
    BadContentType(String),
    #[error("upstream returned status {0}")]
    Status(u16),
    #[error("blocked url: {0}")]
    Blocked(String),
    #[error("transport error: {0}")]
    Transport(String),
}

/// What a fetcher may reach. `allowed_hosts` is filled from the bundled
/// catalog; `https_only` is relaxed only for loopback test servers.
#[derive(Clone, Debug)]
pub struct FetchPolicy {
    pub allowed_hosts: Vec<String>,
    pub https_only: bool,
    pub timeout: Duration,
}

/// Async image fetch, object-safe so a handle can hold a `dyn ImageFetcher`.
pub trait ImageFetcher: Send + Sync + 'static {
    /// Fetch `url`, failing rather than buffering more than `max_bytes`.
    ///
    /// # Errors
    ///
    /// Returns [`FetchError`] for a timeout, an oversized body, a non-image
    /// content type, a non-2xx status, a blocked URL/host/redirect, or a
    /// transport failure.
    fn fetch<'a>(
        &'a self,
        url: &'a str,
        max_bytes: u64,
    ) -> Pin<Box<dyn Future<Output = Result<FetchedImage, FetchError>> + Send + 'a>>;
}

/// The production fetcher: one `reqwest` client with the policy baked in.
#[derive(Clone, Debug)]
pub struct ReqwestFetcher {
    client: Client,
    policy: FetchPolicy,
}

impl ReqwestFetcher {
    /// Build a fetcher with the policy baked into the client.
    ///
    /// # Panics
    ///
    /// Only if the TLS backend itself cannot initialise — the configuration
    /// below is static and valid, so this is a broken-install abort, never a
    /// runtime condition.
    #[must_use]
    pub fn new(policy: FetchPolicy) -> Self {
        let hosts = policy.allowed_hosts.clone();
        let https_only = policy.https_only;
        let redirect = Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                return attempt.stop();
            }
            if hop_allowed(attempt.url(), &hosts, https_only) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        });
        let client = Client::builder()
            .redirect(redirect)
            .timeout(policy.timeout)
            .https_only(https_only)
            .no_proxy()
            .user_agent(USER_AGENT)
            .build()
            .expect("reqwest client configuration is valid");
        Self { client, policy }
    }
}

/// Whether one hop may be requested: scheme, host allowlist, no userinfo.
fn hop_allowed(url: &Url, hosts: &[String], https_only: bool) -> bool {
    if https_only && url.scheme() != "https" {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    url.host_str()
        .is_some_and(|host| hosts.iter().any(|allowed| allowed == host))
}

/// Timeouts are their own variant; everything else is a transport failure with
/// the URL stripped (it may carry a signed query the daemon must not log).
fn map_transport(error: reqwest::Error) -> FetchError {
    if error.is_timeout() {
        FetchError::Timeout
    } else {
        FetchError::Transport(error.without_url().to_string())
    }
}

impl ImageFetcher for ReqwestFetcher {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
        max_bytes: u64,
    ) -> Pin<Box<dyn Future<Output = Result<FetchedImage, FetchError>> + Send + 'a>> {
        Box::pin(async move {
            let parsed =
                Url::parse(url).map_err(|_| FetchError::Blocked("invalid url".to_owned()))?;
            if !hop_allowed(&parsed, &self.policy.allowed_hosts, self.policy.https_only) {
                return Err(FetchError::Blocked("host or scheme not allowed".to_owned()));
            }
            let mut response = self
                .client
                .get(parsed)
                .send()
                .await
                .map_err(map_transport)?;
            let status = response.status();
            if status.is_redirection() {
                // The redirect policy stops every hop it does not allow, so a
                // 3xx reaching here is one we refused to follow.
                return Err(FetchError::Blocked("redirect not followed".to_owned()));
            }
            if !status.is_success() {
                return Err(FetchError::Status(status.as_u16()));
            }
            if response.content_length().is_some_and(|len| len > max_bytes) {
                return Err(FetchError::TooLarge);
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            let media = content_type
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if !ALLOWED_TYPES.contains(&media.as_str()) {
                return Err(FetchError::BadContentType(content_type));
            }
            let cap = usize::try_from(max_bytes).unwrap_or(usize::MAX);
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(map_transport)? {
                if bytes.len().saturating_add(chunk.len()) > cap {
                    return Err(FetchError::TooLarge);
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(FetchedImage {
                bytes,
                content_type,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::body::Body;
    use axum::http::{header, StatusCode};
    use axum::response::Response;
    use axum::routing::get;
    use axum::Router;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    const CAP: u64 = 4096;

    fn test_policy(timeout: Duration) -> FetchPolicy {
        FetchPolicy {
            allowed_hosts: vec!["127.0.0.1".to_owned()],
            https_only: false,
            timeout,
        }
    }

    fn serve_on(listener: TcpListener, router: Router) -> String {
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        format!("http://{addr}")
    }

    async fn serve(router: Router) -> String {
        serve_on(TcpListener::bind("127.0.0.1:0").await.unwrap(), router)
    }

    fn image_response(content_type: &'static str, body: Vec<u8>) -> Response {
        Response::builder()
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from(body))
            .unwrap()
    }

    /// One-shot raw HTTP/1.1 responder, used where axum would always set a
    /// `Content-Length` (the no-content-length streaming case).
    async fn raw_server(response: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await;
            socket.write_all(&response).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn fetches_image_bytes() {
        let base = serve(Router::new().route(
            "/img.jpg",
            get(|| async { image_response("image/jpeg", vec![1, 2, 3]) }),
        ))
        .await;
        let fetcher = ReqwestFetcher::new(test_policy(Duration::from_secs(5)));
        let image = fetcher
            .fetch(&format!("{base}/img.jpg"), CAP)
            .await
            .unwrap();
        assert_eq!(image.bytes, vec![1, 2, 3]);
        assert_eq!(image.content_type, "image/jpeg");
    }

    #[tokio::test]
    async fn rejects_non_image_content_type() {
        let base = serve(Router::new().route(
            "/page",
            get(|| async { image_response("text/plain", b"not an image".to_vec()) }),
        ))
        .await;
        let fetcher = ReqwestFetcher::new(test_policy(Duration::from_secs(5)));
        let error = fetcher
            .fetch(&format!("{base}/page"), CAP)
            .await
            .unwrap_err();
        assert_eq!(error, FetchError::BadContentType("text/plain".to_owned()));
    }

    #[tokio::test]
    async fn rejects_svg_content_type() {
        let base = serve(Router::new().route(
            "/vector.svg",
            get(|| async { image_response("image/svg+xml", b"<svg></svg>".to_vec()) }),
        ))
        .await;
        let fetcher = ReqwestFetcher::new(test_policy(Duration::from_secs(5)));
        let error = fetcher
            .fetch(&format!("{base}/vector.svg"), CAP)
            .await
            .unwrap_err();
        assert_eq!(
            error,
            FetchError::BadContentType("image/svg+xml".to_owned())
        );
    }

    #[tokio::test]
    async fn rejects_body_over_cap_without_content_length() {
        let body = vec![7u8; 64];
        let mut response =
            b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n".to_vec();
        response.extend_from_slice(&body);
        let base = raw_server(response).await;
        let fetcher = ReqwestFetcher::new(test_policy(Duration::from_secs(5)));
        let error = fetcher
            .fetch(&format!("{base}/img.png"), 16)
            .await
            .unwrap_err();
        assert_eq!(error, FetchError::TooLarge);
    }

    #[tokio::test]
    async fn rejects_content_length_over_cap() {
        let base = serve(Router::new().route(
            "/big.png",
            get(|| async { image_response("image/png", vec![0u8; 64]) }),
        ))
        .await;
        let fetcher = ReqwestFetcher::new(test_policy(Duration::from_secs(5)));
        let error = fetcher
            .fetch(&format!("{base}/big.png"), 16)
            .await
            .unwrap_err();
        assert_eq!(error, FetchError::TooLarge);
    }

    #[tokio::test]
    async fn rejects_host_outside_allowlist() {
        let base = serve(Router::new().route(
            "/img.jpg",
            get(|| async { image_response("image/jpeg", vec![1, 2, 3]) }),
        ))
        .await;
        // `localhost` is not in the allowlist, even though it resolves here.
        let url = base.replace("127.0.0.1", "localhost");
        let fetcher = ReqwestFetcher::new(test_policy(Duration::from_secs(5)));
        let error = fetcher.fetch(&url, CAP).await.unwrap_err();
        assert!(matches!(error, FetchError::Blocked(_)), "{error:?}");
    }

    #[tokio::test]
    async fn rejects_redirect_to_other_host() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let target = format!("http://localhost:{port}/img.jpg");
        let router = Router::new().route(
            "/start",
            get(move || {
                let target = target.clone();
                async move {
                    Response::builder()
                        .status(StatusCode::FOUND)
                        .header(header::LOCATION, target)
                        .body(Body::empty())
                        .unwrap()
                }
            }),
        );
        let base = serve_on(listener, router);
        let fetcher = ReqwestFetcher::new(test_policy(Duration::from_secs(5)));
        let error = fetcher
            .fetch(&format!("{base}/start"), CAP)
            .await
            .unwrap_err();
        assert!(matches!(error, FetchError::Blocked(_)), "{error:?}");
    }

    #[tokio::test]
    async fn times_out_slow_server() {
        let base = serve(Router::new().route(
            "/slow.jpg",
            get(|| async {
                tokio::time::sleep(Duration::from_secs(2)).await;
                image_response("image/jpeg", vec![1, 2, 3])
            }),
        ))
        .await;
        // Real time (not `start_paused`): the client timeout is wall-clock.
        let fetcher = ReqwestFetcher::new(test_policy(Duration::from_millis(200)));
        let error = fetcher
            .fetch(&format!("{base}/slow.jpg"), CAP)
            .await
            .unwrap_err();
        assert_eq!(error, FetchError::Timeout);
    }

    #[tokio::test]
    async fn non_2xx_is_status_error() {
        let base = serve(Router::new().route(
            "/missing.jpg",
            get(|| async {
                Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(Body::empty())
                    .unwrap()
            }),
        ))
        .await;
        let fetcher = ReqwestFetcher::new(test_policy(Duration::from_secs(5)));
        let error = fetcher
            .fetch(&format!("{base}/missing.jpg"), CAP)
            .await
            .unwrap_err();
        assert_eq!(error, FetchError::Status(500));
    }
}
