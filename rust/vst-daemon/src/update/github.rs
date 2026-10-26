//! GitHub releases fetch (check side of the update flow).
//!
//! Talks to `api.github.com` (or a mock via `api_base`) for the releases list.
//! All tests use `mockito` — no test touches the real GitHub API.

use serde::Deserialize;

/// The GitHub releases API base for vibe-station.
pub const DEFAULT_API_BASE: &str = "https://api.github.com/repos/fastestdevalive/vibe-station";

/// A single release asset.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct GhAsset {
    pub name: String,
    #[serde(rename = "browser_download_url")]
    pub browser_download_url: String,
    pub size: u64,
}

/// A GitHub release (subset of the API shape we need).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Release {
    #[serde(rename = "tag_name")]
    pub tag_name: String,
    pub prerelease: bool,
    pub draft: bool,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(rename = "html_url")]
    pub html_url: String,
    #[serde(default)]
    pub assets: Vec<GhAsset>,
}

/// Outcome of a releases fetch.
#[derive(Clone, Debug, PartialEq)]
pub enum FetchOutcome {
    Fresh {
        releases: Vec<Release>,
        etag: Option<String>,
    },
    NotModified,
    RateLimited {
        retry_after: Option<String>,
    },
    Offline,
    GithubError(String),
}

const BODY_CAP: usize = 64 * 1024;

/// Truncate `body` to 64 KB on a UTF-8 char boundary, so a huge release body cannot bloat the state file and every WS snapshot.
fn truncate_body(body: &str) -> String {
    if body.len() <= BODY_CAP {
        return body.to_string();
    }
    let mut end = BODY_CAP;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    body[..end].to_string()
}

/// `x-ratelimit-reset` is Unix epoch seconds; `UpdateError.retryAfter` is an
/// RFC 3339 instant so clients can `Date.parse` it (disable Retry, show time).
fn reset_to_rfc3339(raw: &str) -> Option<String> {
    let secs: i64 = raw.trim().parse().ok()?;
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// Fetch the releases list from `{api_base}/releases?per_page=20`.
///
/// `etag` is sent as `If-None-Match`; a 304 maps to `NotModified`. Failures
/// (network, non-2xx, rate-limit) are mapped to `FetchOutcome` variants —
/// never returned as `Err`.
pub async fn fetch_releases(
    client: &reqwest::Client,
    api_base: &str,
    etag: Option<&str>,
) -> FetchOutcome {
    let url = format!("{api_base}/releases?per_page=20");
    let mut req = client
        .get(&url)
        .header(
            "User-Agent",
            format!("vibe-station/{}", env!("CARGO_PKG_VERSION")),
        )
        .header("Accept", "application/vnd.github+json");
    if let Some(etag) = etag {
        req = req.header("If-None-Match", etag);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!(err = %e, "update: GitHub request failed (offline)");
            return FetchOutcome::Offline;
        }
    };

    let status = resp.status();

    if status == reqwest::StatusCode::NOT_MODIFIED {
        return FetchOutcome::NotModified;
    }

    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN
    {
        // Rate limited only when the header says zero remain: a 403 for other reasons is a generic github_error.
        if resp
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.trim() == "0")
            .unwrap_or(false)
        {
            let retry_after = resp
                .headers()
                .get("x-ratelimit-reset")
                .and_then(|v| v.to_str().ok())
                .and_then(reset_to_rfc3339);
            return FetchOutcome::RateLimited { retry_after };
        }
    }

    let etag_out = resp
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let body = match resp.text().await {
        Ok(b) => b,
        Err(e) => return FetchOutcome::GithubError(format!("read body: {e}")),
    };

    if !status.is_success() {
        return FetchOutcome::GithubError(format!(
            "HTTP {status}: {}",
            &body[..body.len().min(200)]
        ));
    }

    let mut releases: Vec<Release> = match serde_json::from_str(&body) {
        Ok(r) => r,
        Err(e) => return FetchOutcome::GithubError(format!("parse releases: {e}")),
    };

    for release in &mut releases {
        if let Some(b) = &release.body {
            release.body = Some(truncate_body(b));
        }
    }

    FetchOutcome::Fresh {
        releases,
        etag: etag_out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // mockito 0.31 runs a single global mock server shared by every test in
    // this process, and our four tests all mock the same `/releases` GET path.
    // Serialize them so a request from one test can never be served by another
    // test's mock (mockito matches the first non-satisfied mock in creation
    // order, so parallel execution would be nondeterministic).
    static MOCK_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn client() -> reqwest::Client {
        reqwest::Client::new()
    }

    fn sample_release_body() -> String {
        serde_json::json!([
            {
                "tag_name": "v1.2.3",
                "prerelease": false,
                "draft": false,
                "body": "Changelog for 1.2.3",
                "html_url": "https://example.com/releases/1.2.3",
                "assets": [
                    {
                        "name": "vst-x86_64-unknown-linux-musl.tar.gz",
                        "browser_download_url": "https://example.com/asset.tar.gz",
                        "size": 12345
                    }
                ]
            }
        ])
        .to_string()
    }

    #[tokio::test]
    async fn parses_200_list_and_etag() {
        let _guard = MOCK_LOCK.lock().await;
        let m = mockito::mock("GET", "/releases?per_page=20")
            .with_status(200)
            .with_header("etag", "\"abc\"")
            .with_body(sample_release_body())
            .expect(1)
            .create();

        let outcome = fetch_releases(&client(), &mockito::server_url(), None).await;
        let FetchOutcome::Fresh { releases, etag } = outcome else {
            panic!("expected Fresh, got {outcome:?}");
        };
        assert_eq!(etag.as_deref(), Some("\"abc\""));
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].tag_name, "v1.2.3");
        assert_eq!(
            releases[0].assets[0].name,
            "vst-x86_64-unknown-linux-musl.tar.gz"
        );
        assert_eq!(releases[0].assets[0].size, 12345);
        m.assert();
    }

    #[tokio::test]
    async fn not_modified_on_304() {
        let _guard = MOCK_LOCK.lock().await;
        let m = mockito::mock("GET", "/releases?per_page=20")
            .with_status(304)
            .expect(1)
            .create();

        let outcome = fetch_releases(&client(), &mockito::server_url(), Some("\"abc\"")).await;
        assert_eq!(outcome, FetchOutcome::NotModified);
        m.assert();
    }

    #[tokio::test]
    async fn rate_limited_on_403_with_zero_remaining() {
        let _guard = MOCK_LOCK.lock().await;
        let m = mockito::mock("GET", "/releases?per_page=20")
            .with_status(403)
            .with_header("x-ratelimit-remaining", "0")
            .with_header("x-ratelimit-reset", "1700000000")
            .expect(1)
            .create();

        let outcome = fetch_releases(&client(), &mockito::server_url(), None).await;
        match outcome {
            FetchOutcome::RateLimited { retry_after } => {
                assert_eq!(retry_after.as_deref(), Some("2023-11-14T22:13:20Z"));
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
        m.assert();
    }

    #[tokio::test]
    async fn body_truncated_on_char_boundary() {
        let _guard = MOCK_LOCK.lock().await;
        // 65535 ASCII 'a's + a 2-byte UTF-8 char => len 65537 > 64 KB cap.
        let mut body = "a".repeat(BODY_CAP - 1);
        body.push('é'); // 2 bytes

        let m = mockito::mock("GET", "/releases?per_page=20")
            .with_status(200)
            .with_body(
                serde_json::json!([
                    {
                        "tag_name": "v1.0.0",
                        "prerelease": false,
                        "draft": false,
                        "body": body,
                        "html_url": "https://example.com",
                        "assets": []
                    }
                ])
                .to_string(),
            )
            .expect(1)
            .create();

        let outcome = fetch_releases(&client(), &mockito::server_url(), None).await;
        let FetchOutcome::Fresh { releases, .. } = outcome else {
            panic!("expected Fresh");
        };
        let b = releases[0].body.as_deref().unwrap();
        assert!(b.len() <= BODY_CAP);
        assert_eq!(b.len(), BODY_CAP - 1, "trailing 2-byte char truncated");
        assert!(b.chars().all(|c| c == 'a'));
        m.assert();
    }

    #[test]
    fn truncate_body_keeps_valid_utf8() {
        let mut s = "x".repeat(BODY_CAP - 1);
        s.push('é');
        let t = truncate_body(&s);
        assert!(std::str::from_utf8(t.as_bytes()).is_ok());
        assert_eq!(t.len(), BODY_CAP - 1);
    }
}
