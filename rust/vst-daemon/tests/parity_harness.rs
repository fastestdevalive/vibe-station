//! Black-box parity harness (part 10, task 1).
//!
//! Drives the SAME read-only, deterministic fixture requests through BOTH
//! daemons and asserts byte-for-byte equality of the responses, except for F1's
//! one documented exception (the `POST /sessions/:id/chat/fork` edit-a-sent-
//! message path, dropped from the Rust daemon in part 07a / commit d151c71).
//!
//! - The RUST side is driven fully in-process via `build_app` +
//!   `tower::ServiceExt::oneshot` (no port is ever bound), with
//!   `Paths::with_home(tempdir)` + a fresh `StoreHandle` so no real
//!   `~/.vibe-station` is touched.
//! - The NODE side cannot be spawned as a child process in this checkout
//!   (pnpm/tsx module resolution), so its responses are captured by the
//!   companion vitest harness `daemon/src/__tests__/parity_harness.test.ts`
//!   (Fastify `app.inject()`, no port bound) and committed here as a fixture.
//!   The committed fixture is the Node baseline; this test asserts the Rust
//!   live responses match it byte-for-byte. Regenerate with:
//!   `PARITY_FIXTURE_OUT=rust/vst-daemon/tests/fixtures/node_parity_fixtures.json \
//!     node <vitest> run --config vitest.parity.config.ts`
//!
//! Environment-dependent routes (GET /settings homeDir; GET /tailscale/status
//! hostname) are excluded from the byte diff — see the report. All assertions
//! are assert!()-based; no bare matches!() is used to swallow a comparison.

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Method, Request};
use tempfile::tempdir;
use tower::ServiceExt;

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_daemon::server::{build_app, BuildServerOptions};
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/node_parity_fixtures.json"
);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeFixture {
    method: String,
    url: String,
    status_code: u16,
    body: String,
}

fn make_opts(tmp: &std::path::Path) -> BuildServerOptions {
    let db_path = tmp.join("vibe-station.db");
    let store = StoreHandle::open(&db_path).unwrap();
    let broadcaster = Broadcaster::new(16);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());
    let paths = Paths::with_home(tmp.to_path_buf());
    BuildServerOptions {
        port: 0,
        auth_state: None,
        no_auth: true,
        dist_path: None,
        persist_epoch: None,
        store,
        broadcaster,
        json_registry,
        tmux: Tmux::new(),
        started_at: Instant::now(),
        version: "test".to_string(),
        paths,
    }
}

async fn rust_request(router: &axum::Router, method: &str, url: &str) -> (u16, String) {
    let req_url = if url == "/health" || url == "/mobile-auth" || url == "/ws" || url.starts_with("/api") {
        url.to_string()
    } else {
        format!("/api{url}")
    };
    let req = Request::builder()
        .uri(&req_url)
        .method(match method {
            "GET" => Method::GET,
            "POST" => Method::POST,
            other => panic!("unsupported fixture method {other}"),
        })
        .body(Body::empty())
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

/// Load the Node-side fixture baseline committed by the vitest harness.
fn load_node_fixtures() -> Vec<NodeFixture> {
    let raw = std::fs::read_to_string(FIXTURES).expect("missing node parity fixtures");
    serde_json::from_str(&raw).expect("node parity fixtures must be valid JSON")
}

/// Routes whose bodies are environment-dependent (the real user's home /
/// installed skills / tailnet hostname) and therefore NOT byte-comparable
/// across the two harnesses. Both daemons must still return the same status
/// code; only the body is exempt from the byte-for-byte check.
fn is_structural_only(url: &str) -> bool {
    url == "/settings" || url == "/tailscale/status" || url == "/skills"
}

#[tokio::test]
async fn rust_matches_node_byte_for_byte_on_deterministic_routes() {
    let tmp = tempdir().unwrap();
    let router = build_app(make_opts(tmp.path()));

    let node_fixtures = load_node_fixtures();
    assert!(
        !node_fixtures.is_empty(),
        "node parity fixtures file must not be empty"
    );

    let mut compared = 0usize;
    let mut mismatches: Vec<String> = Vec::new();

    for fx in &node_fixtures {
        // F1 documented exception: the fork route was dropped from Rust.
        // Assert it is genuinely GONE (404/405), do NOT byte-compare it.
        if fx.url.ends_with("/chat/fork") {
            let (status, body) = rust_request(&router, &fx.method, &fx.url).await;
            assert!(
                status == 404 || status == 405,
                "F1 exception: POST /sessions/:id/chat/fork must be GONE in Rust \
                 (404/405), got status {status} body {body}"
            );
            continue;
        }

        let (status, body) = rust_request(&router, &fx.method, &fx.url).await;
        compared += 1;

        if is_structural_only(&fx.url) {
            // Environment-dependent body; only the status must match.
            assert_eq!(
                status, fx.status_code,
                "{} {} status diverged (env-dependent route)",
                fx.method, fx.url
            );
            continue;
        }

        if status != fx.status_code || body != fx.body {
            mismatches.push(format!(
                "{} {}: node=({}, {}) rust=({}, {})",
                fx.method, fx.url, fx.status_code, fx.body, status, body
            ));
        }
    }

    assert!(
        compared > 0,
        "parity harness must compare at least one route"
    );
    assert!(
        mismatches.is_empty(),
        "Rust responses diverge from the Node baseline on {} route(s):\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

/// The F1 exception is asserted inside the loop above; this test makes the
/// fork-route-gone check independently discoverable by name.
#[tokio::test]
async fn f1_fork_route_is_gone_in_rust() {
    let tmp = tempdir().unwrap();
    let router = build_app(make_opts(tmp.path()));
    let (status, _body) = rust_request(&router, "POST", "/sessions/nonexistent/chat/fork").await;
    assert!(
        status == 404 || status == 405,
        "F1 exception: the edit-a-sent-message fork route must be gone in Rust (404/405)"
    );
}
