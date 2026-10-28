//! Shell-written files reach the Artifacts list: the REAL transcript shape of a
//! Claude `Terminal` call (a `tool_use` with empty input, the command arriving in
//! a later event, then `completed`) goes through a real `JsonAgentSession`, the
//! plugin's `extract_file_effects` and the real `vst-artifacts` pipeline against a
//! real file system and store.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use vst_agents::json_agent_session::{JsonAgentSession, JsonAgentSessionOptions};
use vst_artifacts::{ArtifactsHandle, ScopeResolver, SessionScope};
use vst_types::artifacts::{AddedVia, ScopeKey};
use vst_types::{Broadcaster, NormalizedEvent, NormalizedEventProvider};

const FIXTURE_DIR: &str = "/tmp/claude-1000/-home-vst--vibe-station-projects-northstar-api-worktrees-napi-1/d619cac8-4ca2-48c7-ae90-1f95cce9adf6/scratchpad/outside-files";

struct Resolver {
    scope: ScopeKey,
    root: PathBuf,
    vst_home: PathBuf,
}

#[async_trait]
impl ScopeResolver for Resolver {
    async fn scope_root(&self, scope: &ScopeKey) -> Option<PathBuf> {
        (scope == &self.scope).then(|| self.root.clone())
    }
    async fn session_scope(&self, id: &str) -> Option<SessionScope> {
        (id == "s1").then(|| SessionScope {
            scope: self.scope.clone(),
            cwd: self.root.clone(),
            archived: false,
        })
    }
    async fn registered_roots(&self) -> Vec<PathBuf> {
        vec![]
    }
    async fn scope_exists(&self, scope: &ScopeKey) -> bool {
        scope == &self.scope
    }
    fn vst_home(&self) -> PathBuf {
        self.vst_home.clone()
    }
}

fn fixture_command(n: u8) -> String {
    let raw = std::fs::read_to_string(format!(
        "{}/tests/fixtures/shell/real-command-{n}.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    v["toolInput"]["command"].as_str().unwrap().to_string()
}

fn ev(kind: &str, id: &str, extra: serde_json::Value) -> NormalizedEvent {
    let mut v = serde_json::json!({
        "id": format!("e-{kind}-{id}-{extra}"),
        "sessionId": "s1",
        "ts": "2026-10-31T00:00:00.000Z",
        "provider": "claude",
        "kind": kind,
        "role": "assistant",
        "toolId": id,
        "turnId": "t1",
    });
    for (k, val) in extra.as_object().unwrap() {
        v[k] = val.clone();
    }
    serde_json::from_value(v).unwrap()
}

/// Claude's shape: empty-input start, command in a later update, then completion.
async fn run_shell(session: &JsonAgentSession, id: &str, command: &str, status: &str) {
    session
        .handle_event(&mut ev(
            "tool_use",
            id,
            serde_json::json!({"toolName": "Terminal", "toolKind": "execute",
                "toolStatus": "pending", "toolInput": {}}),
        ))
        .await;
    session
        .handle_event(&mut ev(
            "tool_result",
            id,
            serde_json::json!({"toolKind": "execute", "toolStatus": "pending",
                "toolInput": {"command": command}}),
        ))
        .await;
    session
        .handle_event(&mut ev(
            "tool_result",
            id,
            serde_json::json!({"toolStatus": status}),
        ))
        .await;
}

fn write_files(dir: &Path, names: &[&str]) {
    std::fs::create_dir_all(dir).unwrap();
    for n in names {
        std::fs::write(dir.join(n), format!("content of {n}\n")).unwrap();
    }
}

#[tokio::test]
async fn shell_written_files_become_artifact_rows() {
    let tmp = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(tmp.path()).unwrap();
    let root = base.join("repo");
    let outside = base.join("outside-files");
    let vst_home = base.join("home").join(".vibe-station");
    for d in [&root, &vst_home, &base.join("db"), &root.join("src")] {
        std::fs::create_dir_all(d).unwrap();
    }
    let _home = vst_agents::home::with_home(base.join("home"));
    let store = vst_store::StoreHandle::open(base.join("db").join("store.sqlite")).unwrap();
    let scope = ScopeKey::project("p1");
    let resolver = Arc::new(Resolver {
        scope: scope.clone(),
        root: root.clone(),
        vst_home,
    });
    let handle = ArtifactsHandle::new(store.clone(), Broadcaster::new(256), resolver);

    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    let session = JsonAgentSession::new(JsonAgentSessionOptions {
        project: common::make_project("p1"),
        worktree: None,
        session: common::make_session("s1"),
        plugin: Arc::new(vst_agents::claude::create_claude_plugin()),
        daemon_port: 0,
        cli: NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle: store,
        broadcaster: Broadcaster(tx),
    });
    session.attach_artifact_sink(Arc::new(handle.clone()));
    let d = outside.display().to_string();
    let rows = |h: &ArtifactsHandle| {
        let h = h.clone();
        let scope = scope.clone();
        async move {
            h.drain_now().await;
            h.list(&scope).await.unwrap().items
        }
    };

    // The two real commands, with their directory pointed at a temp dir.
    let c1 = fixture_command(1).replace(FIXTURE_DIR, &d);
    write_files(&outside, &["hello.txt", "notes.md", "info.json"]);
    run_shell(&session, "toolu-1", &c1, "completed").await;
    let got = rows(&handle).await;
    assert_eq!(got.len(), 3, "{got:?}");
    assert!(got.iter().all(|r| r.writers.contains(&"s1".to_string())));
    assert!(got.iter().all(|r| r.added_via == AddedVia::Capture));

    let c2 = fixture_command(2).replace(FIXTURE_DIR, &d);
    write_files(
        &outside,
        &["users.csv", "greet.sh", "config.yaml", "greet.ts"],
    );
    run_shell(&session, "toolu-2", &c2, "completed").await;
    assert_eq!(rows(&handle).await.len(), 7);

    // A failing / partial command: Claude reports a non-zero exit as `failed`.
    // The file it created is registered, the one it never reached is not.
    let cmd = format!("printf x > {d}/made.md && false; printf y > {d}/never.md");
    write_files(&outside, &["made.md"]);
    run_shell(&session, "toolu-3", &cmd, "failed").await;
    let paths: Vec<String> = rows(&handle).await.into_iter().map(|r| r.path).collect();
    assert!(paths.iter().any(|p| p.ends_with("/made.md")), "{paths:?}");
    assert!(!paths.iter().any(|p| p.ends_with("/never.md")), "{paths:?}");

    // A failed shell call whose target exists is registered (it was written
    // before the non-zero exit)...
    write_files(&outside, &["errored.md"]);
    run_shell(
        &session,
        "toolu-4",
        &format!("echo > {d}/errored.md"),
        "failed",
    )
    .await;
    let paths: Vec<String> = rows(&handle).await.into_iter().map(|r| r.path).collect();
    assert!(
        paths.iter().any(|p| p.ends_with("/errored.md")),
        "{paths:?}"
    );

    // ...but a failed EDIT tool call wrote nothing, so nothing is captured.
    write_files(&outside, &["edit-failed.md"]);
    let edit = |status: &str| {
        serde_json::json!({"toolName": "Write", "toolKind": "edit", "toolStatus": status,
            "toolLocations": [{"path": format!("{d}/edit-failed.md")}]})
    };
    session
        .handle_event(&mut ev("tool_use", "toolu-edit", edit("pending")))
        .await;
    session
        .handle_event(&mut ev("tool_result", "toolu-edit", edit("failed")))
        .await;
    let paths: Vec<String> = rows(&handle).await.into_iter().map(|r| r.path).collect();
    assert!(
        !paths.iter().any(|p| p.ends_with("/edit-failed.md")),
        "{paths:?}"
    );

    // Stderr/log noise is never captured even when the files exist.
    write_files(&outside, &["build.log", "err.txt"]);
    run_shell(
        &session,
        "toolu-noise",
        &format!("make > {d}/build.log 2>&1; make 2> {d}/err.txt"),
        "completed",
    )
    .await;
    let paths: Vec<String> = rows(&handle).await.into_iter().map(|r| r.path).collect();
    assert!(!paths
        .iter()
        .any(|p| p.ends_with("build.log") || p.ends_with("err.txt")));

    // Security negatives through the real pipeline: a symlink to a secret, a
    // credentials file, and a FIFO (no hang) are all refused.
    let home = base.join("home");
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::write(home.join(".ssh").join("id_rsa"), "SECRET").unwrap();
    std::fs::write(home.join(".claude").join(".credentials.json"), "{}").unwrap();
    std::os::unix::fs::symlink(home.join(".ssh").join("id_rsa"), outside.join("link.md")).unwrap();
    assert!(std::process::Command::new("mkfifo")
        .arg(outside.join("pipe.md"))
        .status()
        .unwrap()
        .success());
    let before = rows(&handle).await.len();
    run_shell(
        &session,
        "toolu-sec",
        &format!(
            "echo > {d}/link.md; echo > {}; cp -s x {d}/link.md; echo > {d}/pipe.md",
            home.join(".claude").join(".credentials.json").display()
        ),
        "completed",
    )
    .await;
    let after = rows(&handle).await;
    assert_eq!(after.len(), before, "{after:?}");
    assert!(!after.iter().any(|r| r.path.contains(".ssh")
        || r.path.contains("credentials")
        || r.path.ends_with("link.md")
        || r.path.ends_with("pipe.md")));

    // R14: a source file written inside the worktree is not an artifact.
    let rs = root.join("src").join("lib.rs");
    std::fs::write(&rs, "fn main() {}\n").unwrap();
    let before = rows(&handle).await.len();
    run_shell(
        &session,
        "toolu-5",
        &format!("echo > {}", rs.display()),
        "completed",
    )
    .await;
    assert_eq!(rows(&handle).await.len(), before);

    // A repeated call (same files) stays one row per file.
    run_shell(&session, "toolu-6", &c1, "completed").await;
    assert_eq!(rows(&handle).await.len(), before);
}
