//! Contract tests for `vst artifact add|list|pin`.
//!
//! The mock daemon mounts every route under `/api/...` (only `/health` stays
//! at root), exactly like the real `.nest("/api", api)` — an unprefixed mock
//! route would pass while encoding the wrong convention (AGENTS.md "CLI").
//!
//! The CLI reads `VST_DAEMON_URL`/`VST_SPAWN_TOKEN`/`VST_WORKTREE`, which are
//! process-global, so every test that sets them holds `ENV_LOCK`.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::extract::{Json, Path};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};

use vst_cli::commands::artifact::add::{parse_artifact_add_options, run_artifact_add};
use vst_cli::commands::artifact::list::{parse_artifact_list_options, run_artifact_list};
use vst_cli::commands::artifact::pin::{parse_artifact_pin_options, run_artifact_pin};
use vst_cli::program::{parse_args, ArtifactCommand, Command};

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn row(id: &str, path: &str, pinned: bool) -> Value {
    json!({
        "id": id, "scopeKind": "worktree", "scopeId": "wt-1",
        "path": path, "displayPath": path, "inRepo": false, "kind": "doc",
        "size": 4, "state": "ok", "pinned": pinned, "editCount": 1,
        "writers": ["sess-1"], "addedVia": "cli",
        "createdAt": "2026-10-27T10:00:00.000Z",
        "lastWrittenAt": "2026-10-27T10:00:00.000Z"
    })
}

async fn serve(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    format!("http://{addr}")
}

fn health() -> axum::routing::MethodRouter {
    get(|| async { Json(json!({ "ok": true, "version": "0.1.0", "port": 1, "uptime": 1 })) })
}

struct Env;
impl Env {
    fn set(url: &str, token: Option<&str>) -> Env {
        std::env::set_var("VST_DAEMON_URL", url);
        match token {
            Some(t) => std::env::set_var("VST_SPAWN_TOKEN", t),
            None => std::env::remove_var("VST_SPAWN_TOKEN"),
        }
        std::env::remove_var("VST_WORKTREE");
        std::env::remove_var("VST_PROJECT");
        Env
    }
}
impl Drop for Env {
    fn drop(&mut self) {
        for k in [
            "VST_DAEMON_URL",
            "VST_SPAWN_TOKEN",
            "VST_WORKTREE",
            "VST_PROJECT",
        ] {
            std::env::remove_var(k);
        }
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

// ---- parsing -----------------------------------------------------------

#[test]
fn artifact_subcommands_parse() {
    let cmd = parse_args(["vst", "artifact", "add", "a.md", "b.md"]);
    assert_eq!(
        cmd,
        Command::Artifact(ArtifactCommand::Add {
            args: s(&["a.md", "b.md"])
        })
    );
    assert!(matches!(
        parse_args(["vst", "artifact", "list", "--json"]),
        Command::Artifact(ArtifactCommand::List { .. })
    ));
    assert!(matches!(
        parse_args(["vst", "artifact", "pin", "x", "--unpin"]),
        Command::Artifact(ArtifactCommand::Pin { .. })
    ));
    assert!(matches!(
        parse_args(["vst", "artifact", "nope"]),
        Command::Artifact(ArtifactCommand::Unknown(_))
    ));
    assert!(parse_artifact_add_options(&s(&[])).is_err());
    assert!(parse_artifact_pin_options(&s(&["--worktree=w"])).is_err());
}

// ---- add ---------------------------------------------------------------

#[tokio::test]
async fn add_sends_one_prefixed_request_with_absolute_paths_and_token() {
    let _g = ENV_LOCK.lock().await;
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let router = Router::new().route("/health", health()).route(
        "/api/artifacts",
        post({
            let seen = seen.clone();
            move |Json(body): Json<Value>| {
                let seen = seen.clone();
                async move {
                    let paths = body["paths"].as_array().unwrap().clone();
                    seen.lock().unwrap().push(body);
                    let results: Vec<Value> = paths
                        .iter()
                        .map(|p| {
                            let p = p.as_str().unwrap();
                            json!({ "path": p, "artifact": row("a1", p, false), "outsideWorktree": true })
                        })
                        .collect();
                    Json(json!({ "results": results }))
                }
            }
        }),
    );
    let _env = Env::set(&serve(router).await, Some("sess-1"));

    let opts = parse_artifact_add_options(&s(&["rel/a.md", "/tmp/b.png", "--json"])).unwrap();
    assert!(opts.json);
    run_artifact_add(opts).await.expect("exit 0");

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1, "several paths are ONE request");
    assert_eq!(seen[0]["spawnToken"], "sess-1");
    let paths: Vec<&str> = seen[0]["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap())
        .collect();
    assert!(paths.iter().all(|p| p.starts_with('/')), "{paths:?}");
    assert!(paths[0].ends_with("rel/a.md"));
}

#[tokio::test]
async fn add_exit_codes_per_path_errors_and_whole_request_errors() {
    let _g = ENV_LOCK.lock().await;
    let mode: Arc<Mutex<&'static str>> = Arc::new(Mutex::new("denied"));
    let router = Router::new().route("/health", health()).route(
        "/api/artifacts",
        post({
            let mode = mode.clone();
            move |Json(body): Json<Value>| {
                let mode = *mode.lock().unwrap();
                async move {
                    let p = body["paths"][0].as_str().unwrap().to_string();
                    match mode {
                        "denied" => (
                            StatusCode::OK,
                            Json(json!({ "results": [{ "path": p, "error": { "code": "ARTIFACT_DENIED", "message": "never" } }] })),
                        ),
                        "notfound" => (
                            StatusCode::OK,
                            Json(json!({ "results": [{ "path": p, "error": { "code": "NOT_FOUND", "message": "gone" } }] })),
                        ),
                        "rate" => (
                            StatusCode::TOO_MANY_REQUESTS,
                            Json(json!({ "error": "RATE_LIMITED", "message": "slow down" })),
                        ),
                        _ => (
                            StatusCode::NOT_FOUND,
                            Json(json!({ "error": "NOT_FOUND", "message": "unknown session" })),
                        ),
                    }
                }
            }
        }),
    );
    let _env = Env::set(&serve(router).await, Some("sess-1"));
    let run = |p: &str| {
        let opts = parse_artifact_add_options(&s(&[p])).unwrap();
        async move { run_artifact_add(opts).await }
    };

    assert_eq!(run("/x").await.unwrap_err().1, 1, "ARTIFACT_DENIED -> 1");
    *mode.lock().unwrap() = "notfound";
    assert_eq!(run("/x").await.unwrap_err().1, 2, "all NOT_FOUND -> 2");
    *mode.lock().unwrap() = "rate";
    let (msg, code) = run("/x").await.unwrap_err();
    assert_eq!(code, 1);
    assert!(msg.contains("wait"), "{msg}");
    *mode.lock().unwrap() = "unknown";
    assert_eq!(run("/x").await.unwrap_err().1, 2, "unknown session -> 2");
}

#[tokio::test]
async fn add_without_spawn_token_fails_before_any_request() {
    let _g = ENV_LOCK.lock().await;
    let hits: Arc<Mutex<u32>> = Arc::default();
    let router = Router::new().route("/health", health()).route(
        "/api/artifacts",
        post({
            let hits = hits.clone();
            move || {
                let hits = hits.clone();
                async move {
                    *hits.lock().unwrap() += 1;
                    Json(json!({ "results": [] }))
                }
            }
        }),
    );
    let _env = Env::set(&serve(router).await, None);
    let (msg, code) = run_artifact_add(parse_artifact_add_options(&s(&["/x"])).unwrap())
        .await
        .unwrap_err();
    assert_eq!(code, 1);
    assert!(msg.contains("vst agent session"), "{msg}");
    assert_eq!(*hits.lock().unwrap(), 0);
}

// ---- list + pin --------------------------------------------------------

fn scope_router(pins: Arc<Mutex<Vec<(String, Value)>>>, pin_status: StatusCode) -> Router {
    Router::new()
        .route("/health", health())
        .route(
            "/api/worktrees/:id/artifacts",
            get(|Path(id): Path<String>| async move {
                assert_eq!(id, "wt-1");
                Json(json!({
                    "rev": 4, "cap": 500, "total": 2,
                    "items": [row("id-a", "/tmp/a.md", false), row("id-b", "/tmp/b.md", true)]
                }))
            }),
        )
        .route(
            "/api/artifacts/:id/pin",
            post(move |Path(id): Path<String>, Json(body): Json<Value>| {
                let pins = pins.clone();
                async move {
                    pins.lock().unwrap().push((id.clone(), body.clone()));
                    if pin_status != StatusCode::OK {
                        return (
                            pin_status,
                            Json(json!({ "error": "PIN_LIMIT", "message": "full" })),
                        );
                    }
                    let pinned = body["pinned"].as_bool().unwrap();
                    (
                        StatusCode::OK,
                        Json(json!({ "artifact": row(&id, "/tmp/a.md", pinned) })),
                    )
                }
            }),
        )
}

#[tokio::test]
async fn list_uses_the_prefixed_scope_route_and_env_default() {
    let _g = ENV_LOCK.lock().await;
    let router = scope_router(Arc::default(), StatusCode::OK);
    let _env = Env::set(&serve(router).await, None);
    std::env::set_var("VST_WORKTREE", "wt-1");
    let opts = parse_artifact_list_options(&s(&[])).unwrap();
    assert_eq!(opts.scope.list_path(), "/worktrees/wt-1/artifacts");
    run_artifact_list(opts).await.expect("ok");
    // an unknown scope maps to exit 2
    let opts = parse_artifact_list_options(&s(&["--project", "nope"])).unwrap();
    // the mock has no /api/projects route: the fallback 404 has no JSON body
    assert_eq!(run_artifact_list(opts).await.unwrap_err().1, 2);
}

#[tokio::test]
async fn pin_resolves_a_path_to_an_id_and_posts_to_the_prefixed_route() {
    let _g = ENV_LOCK.lock().await;
    let pins: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let _env = Env::set(
        &serve(scope_router(pins.clone(), StatusCode::OK)).await,
        None,
    );

    // by path
    let opts = parse_artifact_pin_options(&s(&["/tmp/a.md", "--worktree", "wt-1"])).unwrap();
    run_artifact_pin(opts).await.expect("pinned");
    // by id, unpin
    let opts = parse_artifact_pin_options(&s(&["id-b", "--worktree=wt-1", "--unpin"])).unwrap();
    run_artifact_pin(opts).await.expect("unpinned");
    // unknown target -> 2, no request
    let opts = parse_artifact_pin_options(&s(&["/tmp/none.md", "--worktree=wt-1"])).unwrap();
    assert_eq!(run_artifact_pin(opts).await.unwrap_err().1, 2);

    let pins = pins.lock().unwrap();
    assert_eq!(pins.len(), 2);
    assert_eq!(pins[0].0, "id-a");
    assert_eq!(pins[0].1, json!({ "pinned": true }));
    assert_eq!(pins[1].0, "id-b");
    assert_eq!(pins[1].1, json!({ "pinned": false }));
}

#[tokio::test]
async fn pin_limit_conflict_exits_1() {
    let _g = ENV_LOCK.lock().await;
    let _env = Env::set(
        &serve(scope_router(Arc::default(), StatusCode::CONFLICT)).await,
        None,
    );
    let opts = parse_artifact_pin_options(&s(&["id-a", "--worktree=wt-1"])).unwrap();
    let (msg, code) = run_artifact_pin(opts).await.unwrap_err();
    assert_eq!(code, 1);
    assert!(msg.contains("pin limit"), "{msg}");
}
