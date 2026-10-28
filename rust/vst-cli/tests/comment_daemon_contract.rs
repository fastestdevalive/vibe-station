//! Contract tests for `vst comment list|show`.
//!
//! The mock daemon mounts every route under `/api/...` (only `/health` stays at
//! root), exactly like the real `.nest("/api", api)` -- an unprefixed mock route
//! would pass while encoding the wrong convention (AGENTS.md "CLI").
//!
//! The CLI reads `VST_DAEMON_URL`/`VST_WORKTREE`/`VST_PROJECT`, which are
//! process-global, so every test that sets them holds `ENV_LOCK`.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::extract::{Json, Path, Query};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use serde_json::{json, Value};

use vst_cli::commands::comment::list::{
    fetch_comments, parse_comment_list_options, render_output as render_list, request_path,
};
use vst_cli::commands::comment::show::{
    fetch_comment, parse_comment_show_options, render_output as render_show,
};
use vst_cli::program::{parse_args, Command, CommentCommand};

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn comment(id: &str, pin: u32, path: &str, text: &str) -> Value {
    json!({
        "id": id, "scopeKind": "worktree", "scopeId": "wt-1", "pin": pin,
        "path": path, "pathKind": "repo", "surface": "file",
        "lineStart": 4, "lineEnd": 6,
        "quote": "let x = 1;", "prefix": "", "suffix": "", "occurrence": 0,
        "text": text, "anchor": "anchored", "blockBytes": 80, "version": 1,
        "createdAt": "2026-10-27T10:00:00.000Z", "updatedAt": "2026-10-27T10:00:00.000Z"
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
    fn set(url: &str) -> Env {
        std::env::set_var("VST_DAEMON_URL", url);
        std::env::remove_var("VST_WORKTREE");
        std::env::remove_var("VST_PROJECT");
        Env
    }
}
impl Drop for Env {
    fn drop(&mut self) {
        for k in ["VST_DAEMON_URL", "VST_WORKTREE", "VST_PROJECT"] {
            std::env::remove_var(k);
        }
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

#[derive(serde::Deserialize)]
struct ListQuery {
    delivery: Option<String>,
}

/// `delivery` values the mock saw, and the paths it was asked for.
type Seen = Arc<Mutex<Vec<(String, Option<String>)>>>;

fn router(seen: Seen) -> Router {
    let list = |scope: &'static str, seen: Seen| {
        get(move |Path(id): Path<String>, Query(q): Query<ListQuery>| {
            let seen = seen.clone();
            async move {
                seen.lock()
                    .unwrap()
                    .push((format!("{scope}/{id}"), q.delivery.clone()));
                let comments = if q.delivery.as_deref() == Some("unsent") {
                    vec![comment("c1", 1, "src/a.rs", "rename this")]
                } else {
                    vec![
                        comment("c1", 1, "src/a.rs", "rename this"),
                        comment("c2", 2, "src/b.rs", "attached one"),
                    ]
                };
                Json(json!({ "comments": comments, "nextPin": 3, "terminalDeliveries": [] }))
            }
        })
    };
    Router::new()
        .route("/health", health())
        .route(
            "/api/worktrees/:id/comments",
            list("worktrees", seen.clone()),
        )
        .route("/api/projects/:id/comments", list("projects", seen))
        .route(
            "/api/comments/:id",
            get(|Path(id): Path<String>| async move {
                if id == "c1" {
                    Json(json!({ "comment": comment("c1", 1, "src/a.rs", "rename this") }))
                        .into_response()
                } else {
                    (
                        StatusCode::NOT_FOUND,
                        Json(json!({ "error": "not_found", "message": "x" })),
                    )
                        .into_response()
                }
            }),
        )
}

#[test]
fn comment_subcommands_parse() {
    assert_eq!(
        parse_args(["vst", "comment", "list", "--unsent", "--json"]),
        Command::Comment(CommentCommand::List {
            args: s(&["--unsent", "--json"])
        })
    );
    assert!(matches!(
        parse_args(["vst", "comment", "show", "c1"]),
        Command::Comment(CommentCommand::Show { .. })
    ));
    assert!(matches!(
        parse_args(["vst", "comment", "nope"]),
        Command::Comment(CommentCommand::Unknown(_))
    ));
    assert!(parse_comment_show_options(&s(&[])).is_err());
    assert!(parse_comment_show_options(&s(&["a", "b"])).is_err());
    assert!(parse_comment_list_options(&s(&["extra"])).is_err());
}

#[tokio::test]
async fn list_unsent_json_prints_the_array_from_the_prefixed_scope_route() {
    let _g = ENV_LOCK.lock().await;
    let seen: Seen = Arc::default();
    let _env = Env::set(&serve(router(seen.clone())).await);
    std::env::set_var("VST_WORKTREE", "wt-1");

    let opts = parse_comment_list_options(&s(&["--unsent", "--json"])).unwrap();
    assert_eq!(
        request_path(&opts),
        "/worktrees/wt-1/comments?delivery=unsent"
    );
    let comments = fetch_comments(&opts).await.expect("ok");
    let printed = render_list(opts.json, &comments);
    assert_eq!(printed.len(), 1);
    let parsed: Value = serde_json::from_str(&printed[0]).unwrap();
    assert!(parsed.is_array(), "--json prints the bare array");
    assert_eq!(parsed.as_array().unwrap().len(), 1);
    assert_eq!(parsed[0]["id"], "c1");
    assert_eq!(parsed[0]["text"], "rename this");

    // Without --unsent every comment in the panel is listed.
    let all = parse_comment_list_options(&s(&["--json"])).unwrap();
    assert_eq!(fetch_comments(&all).await.unwrap().len(), 2);
    // The table form names the file, lines and text.
    let table = render_list(false, &comments).join("\n");
    assert!(
        table.contains("src/a.rs:L4-6") && table.contains("rename this"),
        "{table}"
    );

    let seen = seen.lock().unwrap();
    assert_eq!(
        seen[0],
        ("worktrees/wt-1".to_string(), Some("unsent".to_string()))
    );
    assert_eq!(seen[1], ("worktrees/wt-1".to_string(), None));
}

#[tokio::test]
async fn project_scope_comes_from_the_environment_when_no_worktree() {
    let _g = ENV_LOCK.lock().await;
    let seen: Seen = Arc::default();
    let _env = Env::set(&serve(router(seen.clone())).await);
    std::env::set_var("VST_PROJECT", "p-1");
    let opts = parse_comment_list_options(&s(&[])).unwrap();
    assert_eq!(opts.path, "/projects/p-1/comments");
    fetch_comments(&opts).await.expect("ok");
    assert_eq!(seen.lock().unwrap()[0].0, "projects/p-1");
    // No scope at all is a usage error, before any request.
    std::env::remove_var("VST_PROJECT");
    assert!(parse_comment_list_options(&s(&[])).is_err());
}

#[tokio::test]
async fn show_prints_the_comment_and_404_exits_2() {
    let _g = ENV_LOCK.lock().await;
    let _env = Env::set(&serve(router(Arc::default())).await);

    let c = fetch_comment("c1").await.expect("ok");
    assert_eq!(c.pin, 1);
    let opts = parse_comment_show_options(&s(&["c1", "--json"])).unwrap();
    let json = render_show(opts.json, &c);
    assert_eq!(serde_json::from_str::<Value>(&json[0]).unwrap()["id"], "c1");
    let detail = render_show(false, &c).join("\n");
    assert!(
        detail.contains("File:    src/a.rs") && detail.contains("Lines:   L4-6"),
        "{detail}"
    );
    assert!(
        detail.contains("  | let x = 1;") && detail.contains("  | rename this"),
        "{detail}"
    );

    let err = fetch_comment("gone").await.unwrap_err();
    assert_eq!(err.1, 2, "a 404 exits 2");
    assert_eq!(err.0, "not found");
}
