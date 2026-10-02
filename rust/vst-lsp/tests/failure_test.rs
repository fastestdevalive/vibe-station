//! Start-failure classification, latching and recovery, driven by the fake
//! LSP server in `fixtures/fake_lsp.py` installed under a real server's
//! command name on a temp `$PATH`.
//!
//! Phase-classification tests use `pyright-langserver` (no dependency model)
//! so the TypeScript probe can't interfere; dependency tests use
//! `typescript-language-server` with `npm root -g` pinned to `None`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use vst_lsp::manager::{LspError, LspManager, LspRequestKind, WorkspaceKey};
use vst_lsp::status::LspStatus;
use vst_types::rest::lsp::{LspDegradedLevel, LspFailureKind, LspFileRef};

// Tests here mutate process-global env (PATH, FAKE_LSP_*): serialize them.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Env {
    _bin: tempfile::TempDir,
    _vst: tempfile::TempDir,
    root: tempfile::TempDir,
    log: PathBuf,
    init_log: PathBuf,
    orig_path: String,
    manager: Arc<LspManager>,
    ws: WorkspaceKey,
}

impl Env {
    /// Installs the fake server as `command`, sets `mode`, writes `file`.
    fn new(command: &str, mode: &str, file: &str) -> Self {
        let bin = tempfile::tempdir().unwrap();
        let fake = bin.path().join(command);
        std::fs::copy(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake_lsp.py"),
            &fake,
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let log = bin.path().join("invocations.log");
        let init_log = bin.path().join("init-options.log");
        let orig_path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{}", bin.path().display(), orig_path));
        std::env::set_var("FAKE_LSP_MODE", mode);
        std::env::set_var("FAKE_LSP_LOG", &log);
        std::env::set_var("FAKE_LSP_INIT_LOG", &init_log);
        std::env::remove_var("FAKE_LSP_ERROR");

        let vst = tempfile::tempdir().unwrap();
        let manager = LspManager::new(vst.path().to_path_buf());
        manager.set_npm_global_root(None);
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "x = 1\n").unwrap();
        Self {
            _bin: bin,
            _vst: vst,
            root,
            log,
            init_log,
            orig_path,
            manager,
            ws: WorkspaceKey::Worktree {
                project_id: "p".into(),
                worktree_id: "w".into(),
            },
        }
    }

    async fn request(&self, lang: &str, file: &str) -> Result<(), LspError> {
        self.manager
            .request(
                self.ws.clone(),
                self.root.path(),
                lang,
                LspFileRef::Workspace { path: file.into() },
                LspRequestKind::Definition,
                Some((0, 0)),
                true,
            )
            .await
            .map(|_| ())
    }

    fn spawns(&self) -> usize {
        std::fs::read_to_string(&self.log)
            .map(|c| c.lines().count())
            .unwrap_or(0)
    }

    async fn wait_spawns(&self, n: usize, secs: u64) -> usize {
        for _ in 0..secs * 20 {
            if self.spawns() >= n {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.spawns()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        std::env::set_var("PATH", &self.orig_path);
        for k in [
            "FAKE_LSP_MODE",
            "FAKE_LSP_LOG",
            "FAKE_LSP_INIT_LOG",
            "FAKE_LSP_ERROR",
        ] {
            std::env::remove_var(k);
        }
    }
}

fn failed_kind(r: Result<(), LspError>) -> LspFailureKind {
    match r {
        Err(LspError::Failed(f)) => f.kind,
        other => panic!("expected LspError::Failed, got {other:?}"),
    }
}

/// D4: a server that RPC-errors on `initialize` is spawned exactly once, no
/// matter how many requests follow — each gets the latched failure back.
#[tokio::test]
#[allow(clippy::await_holding_lock)] // ENV_LOCK guards process-global env vars
async fn init_rpc_error_latches_and_never_respawns() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let env = Env::new("pyright-langserver", "rpc-error-init", "a.py");

    for _ in 0..6 {
        assert_eq!(
            failed_kind(env.request("python", "a.py").await),
            LspFailureKind::InitFailed
        );
    }
    assert_eq!(env.spawns(), 1, "exactly one spawn for N requests");

    let (status, lang, failure) = env.manager.status_with_failure(&env.ws, "a.py", true).await;
    assert_eq!(status, LspStatus::Error);
    assert_eq!(lang.as_deref(), Some("python"));
    let failure = failure.expect("latched failure on status");
    assert_eq!(failure.kind, LspFailureKind::InitFailed);
    assert_eq!(
        failure.summary,
        "pyright-langserver failed to start: fake failure"
    );
    assert!(failure.message.unwrap().contains("fake failure"));
    assert!(!failure.auto_retry);
    // Polling status never respawns a non-dependency failure either.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(env.spawns(), 1);
}

/// D10: restart clears the latch and spawns exactly once more.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn restart_clears_latch_and_spawns_once() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let env = Env::new("pyright-langserver", "rpc-error-init", "a.py");
    let _ = env.request("python", "a.py").await;
    assert_eq!(env.spawns(), 1);

    std::env::set_var("FAKE_LSP_MODE", "stay-alive");
    env.manager
        .restart(&env.ws, env.root.path(), "python")
        .await
        .unwrap();
    assert_eq!(env.wait_spawns(2, 2).await, 2);
    let (status, _, failure) = env.manager.status_with_failure(&env.ws, "a.py", true).await;
    assert!(failure.is_none(), "latch cleared");
    assert!(
        matches!(status, LspStatus::Starting | LspStatus::Ready),
        "{status:?}"
    );
    // Requests reuse the restarted server.
    let _ = env.request("python", "a.py").await;
    assert_eq!(env.spawns(), 2);
}

/// D5: EOF before the initialize reply → ExitedOnStart with the exit code and
/// the server's stderr (D6), reported promptly (not after the 10 s timeout).
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn exit_before_reply_is_exited_on_start_with_stderr() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let env = Env::new("pyright-langserver", "exit-before-reply", "a.py");
    let started = std::time::Instant::now();
    let r = env.request("python", "a.py").await;
    assert!(started.elapsed() < Duration::from_secs(5), "no 10 s wait");
    let Err(LspError::Failed(f)) = r else {
        panic!("expected Failed, got {r:?}");
    };
    assert_eq!(f.kind, LspFailureKind::ExitedOnStart);
    assert_eq!(f.exit_code, Some(1));
    assert_eq!(
        f.summary,
        "pyright-langserver exited during startup (exit code 1)."
    );
    assert!(
        f.message.as_deref().unwrap_or("").contains("fatal: boom"),
        "{:?}",
        f.message
    );
}

/// D5: no initialize reply within the client timeout → InitTimeout.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn never_reply_is_init_timeout() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let env = Env::new("pyright-langserver", "never-reply", "a.py");
    assert_eq!(
        failed_kind(env.request("python", "a.py").await),
        LspFailureKind::InitTimeout
    );
    assert_eq!(env.spawns(), 1);
}

/// D5 + D4: a server that dies after a successful initialize is Crashed and
/// auto-restarted with backoff, at most `MAX_CRASH_RESTARTS` times, then
/// latched as a plain Error.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn crash_restarts_with_backoff_then_latches() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let env = Env::new("pyright-langserver", "die-after-init", "a.py");
    env.manager
        .set_timing(Duration::from_secs(3600), vec![Duration::from_millis(100)]);
    let _ = env.request("python", "a.py").await;

    // 1 initial spawn + 3 restarts.
    assert_eq!(env.wait_spawns(4, 5).await, 4);
    let mut failure = None;
    for _ in 0..60 {
        let (_, _, f) = env.manager.status_with_failure(&env.ws, "a.py", true).await;
        if f.as_ref().is_some_and(|f| !f.auto_retry) {
            failure = f;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let failure = failure.expect("crash latched after retries are exhausted");
    assert_eq!(failure.kind, LspFailureKind::Crashed);
    assert!(
        failure.summary.contains("keeps crashing (4 times"),
        "{}",
        failure.summary
    );
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(env.spawns(), 4, "no further restarts once latched");
}

/// D6: ~1 MB of stderr before the initialize reply must not block the server
/// (the drain task keeps the pipe empty), so it still comes up.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn stderr_flood_does_not_block_startup() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let env = Env::new("pyright-langserver", "stderr-flood", "a.py");
    let r = tokio::time::timeout(Duration::from_secs(8), env.request("python", "a.py"))
        .await
        .expect("request must not hang on a full stderr pipe");
    assert!(r.is_ok() || matches!(r, Err(LspError::Starting)), "{r:?}");
    let (_, _, failure) = env.manager.status_with_failure(&env.ws, "a.py", true).await;
    assert!(failure.is_none());
}

fn install_ts(dir: &Path, version: &str, with_tsserver: bool) {
    let pkg = dir.join("node_modules/typescript");
    std::fs::create_dir_all(pkg.join("lib")).unwrap();
    std::fs::write(
        pkg.join("package.json"),
        format!(r#"{{ "version": "{version}" }}"#),
    )
    .unwrap();
    if with_tsserver {
        std::fs::write(pkg.join("lib/tsserver.js"), "").unwrap();
    }
}

const TS_MISSING: &str = "Request initialize failed with message: Could not find a valid \
    TypeScript installation. Please ensure that the \"typescript\" dependency is installed in \
    the workspace or that a valid `tsserver.path` is specified. Exiting.";

/// D7 + section 6: a `Missing` probe still allows ONE real spawn; when it
/// fails too the classification is confirmed and latched (with the server's
/// own text as the message), and later requests don't spawn. Retry gives the
/// real attempt back.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn missing_typescript_gets_one_guarded_spawn_then_latches() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let env = Env::new("typescript-language-server", "rpc-error-init", "src/a.ts");
    std::env::set_var("FAKE_LSP_ERROR", TS_MISSING);

    let r = env.request("typescript", "src/a.ts").await;
    let Err(LspError::Failed(f)) = r else {
        panic!("expected Failed, got {r:?}");
    };
    assert_eq!(f.kind, LspFailureKind::MissingDependency);
    assert_eq!(
        f.summary,
        "TypeScript isn't installed for this project — code navigation needs it."
    );
    assert!(f
        .message
        .as_deref()
        .unwrap()
        .contains("Could not find a valid"));
    assert!(f.auto_retry, "dependency failures are re-probed");
    assert_eq!(
        f.remediation[0].command.as_deref(),
        Some("npm i -D \"typescript@<7\"")
    );
    for _ in 0..4 {
        assert_eq!(
            failed_kind(env.request("typescript", "src/a.ts").await),
            LspFailureKind::MissingDependency
        );
    }
    assert_eq!(env.spawns(), 1);

    env.manager
        .restart(&env.ws, env.root.path(), "typescript")
        .await
        .unwrap();
    assert_eq!(
        env.wait_spawns(2, 2).await,
        2,
        "Retry = one more real attempt"
    );
}

/// D7: a workspace TypeScript 7 (no tsserver.js) with no fallback anywhere
/// short-circuits the spawn entirely.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn incompatible_typescript_short_circuits_spawn() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let env = Env::new("typescript-language-server", "stay-alive", "src/a.ts");
    install_ts(env.root.path(), "7.0.2", false);
    for _ in 0..3 {
        assert_eq!(
            failed_kind(env.request("typescript", "src/a.ts").await),
            LspFailureKind::IncompatibleDependency
        );
    }
    assert_eq!(env.spawns(), 0, "probe short-circuits: no process at all");
    let (status, _, failure) = env
        .manager
        .status_with_failure(&env.ws, "src/a.ts", true)
        .await;
    assert_eq!(status, LspStatus::Error);
    assert!(failure
        .unwrap()
        .summary
        .contains("TypeScript 7.0.2 has no tsserver"));
}

/// D8: once a dependency failure is latched, installing TypeScript is picked
/// up by the (throttled) status re-probe: Error → Starting with no Retry.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn reprobe_clears_latch_after_install() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let env = Env::new("typescript-language-server", "rpc-error-init", "src/a.ts");
    std::env::set_var("FAKE_LSP_ERROR", TS_MISSING);
    env.manager
        .set_timing(Duration::from_millis(0), vec![Duration::from_secs(2)]);
    let _ = env.request("typescript", "src/a.ts").await;
    let (status, _, failure) = env
        .manager
        .status_with_failure(&env.ws, "src/a.ts", true)
        .await;
    assert_eq!(status, LspStatus::Error);
    assert_eq!(failure.unwrap().kind, LspFailureKind::MissingDependency);
    assert_eq!(env.spawns(), 1);

    install_ts(env.root.path(), "5.9.3", true);
    std::env::set_var("FAKE_LSP_MODE", "stay-alive");
    let (status, _, failure) = env
        .manager
        .status_with_failure(&env.ws, "src/a.ts", true)
        .await;
    assert!(failure.is_none(), "latch cleared by re-probe");
    assert!(
        matches!(status, LspStatus::Starting | LspStatus::Ready),
        "{status:?}"
    );
    assert_eq!(env.wait_spawns(2, 2).await, 2);
}

/// D8: a re-probe that still finds TypeScript missing refreshes the install
/// command when the package manager changed (a lockfile appeared).
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn reprobe_refreshes_install_command() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let env = Env::new("typescript-language-server", "rpc-error-init", "src/a.ts");
    std::env::set_var("FAKE_LSP_ERROR", TS_MISSING);
    env.manager
        .set_timing(Duration::from_millis(0), vec![Duration::from_secs(2)]);
    let _ = env.request("typescript", "src/a.ts").await;

    std::fs::write(env.root.path().join("pnpm-lock.yaml"), "").unwrap();
    let (_, _, failure) = env
        .manager
        .status_with_failure(&env.ws, "src/a.ts", true)
        .await;
    let failure = failure.expect("still missing");
    assert_eq!(failure.kind, LspFailureKind::MissingDependency);
    assert_eq!(
        failure.remediation[0].command.as_deref(),
        Some("pnpm add -D \"typescript@<7\"")
    );
}

/// D8: with a long throttle, a dependency-manifest change (watcher event)
/// re-probes immediately.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn manifest_change_reprobes_immediately() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let env = Env::new("typescript-language-server", "stay-alive", "src/a.ts");
    env.manager
        .set_timing(Duration::from_secs(3600), vec![Duration::from_secs(2)]);
    install_ts(env.root.path(), "7.0.2", false);
    let _ = env.request("typescript", "src/a.ts").await;
    assert_eq!(env.spawns(), 0);
    // Let the watcher finish starting before the change.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // "npm i -D typescript@5": node_modules (unwatched) + package.json.
    std::fs::remove_dir_all(env.root.path().join("node_modules")).unwrap();
    install_ts(env.root.path(), "5.9.3", true);
    std::fs::write(
        env.root.path().join("package.json"),
        r#"{ "devDependencies": { "typescript": "<7" } }"#,
    )
    .unwrap();
    assert_eq!(
        env.wait_spawns(1, 5).await,
        1,
        "respawned after manifest change"
    );
}

/// D7: a nested `web-ui/node_modules/typescript` is passed as
/// `tsserver.fallbackPath` and surfaced as an info-level `degraded` note.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn nested_typescript_fallback_path_and_info_note() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let env = Env::new("typescript-language-server", "stay-alive", "src/a.ts");
    install_ts(&env.root.path().join("web-ui"), "5.4.5", true);
    let _ = env.request("typescript", "src/a.ts").await;
    assert_eq!(env.spawns(), 1);

    let init = std::fs::read_to_string(&env.init_log).unwrap();
    let opts: serde_json::Value = serde_json::from_str(init.lines().next().unwrap()).unwrap();
    let fallback = opts["tsserver"]["fallbackPath"].as_str().unwrap();
    assert!(
        fallback.ends_with("web-ui/node_modules/typescript/lib/tsserver.js"),
        "{fallback}"
    );
    assert!(opts["tsserver"].get("path").is_none());

    let mut degraded = None;
    for _ in 0..60 {
        degraded = env.manager.degraded_info(&env.ws, "src/a.ts").await;
        if degraded.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let d = degraded.expect("info note while running on the fallback");
    assert_eq!(d.level, LspDegradedLevel::Info);
    assert!(d
        .message
        .starts_with("Using TypeScript 5.4.5 (from web-ui/)"));
    let (_, _, failure) = env
        .manager
        .status_with_failure(&env.ws, "src/a.ts", true)
        .await;
    assert!(failure.is_none(), "failure and degraded are never both set");
}
