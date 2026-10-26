//! oh-my-pi (`omp`) plugin.
//!
//! Terminal channel: `omp` TUI, system prompt via `--append-system-prompt <file>`
//! (inline delivery, 12s fallback ready signal). Rich Chat (json) channel: omp
//! speaks ACP natively (`omp acp`), so no adapter binary is needed.
//!
//! Both channels pin omp's session store to a per-vst-session directory
//! (`--session-dir <cwd>/.vibe-station/omp-sessions/<sessionId>`). omp mints its
//! own session ids (no "create with this id" flag, unlike pi), so a private store
//! is how the daemon finds *this* session's id (`capture_chat_id`) and how a
//! json↔terminal toggle resumes the same conversation (`--resume <id>`).
//!
//! Two-identity strategy: `identical` — the ACP `session/new` id is assumed to be
//! omp's own session id (the `<ts>_<id>.jsonl` suffix), so this plugin implements
//! neither `capture_native_chat_id` nor `supports_json_to_terminal_resume`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use agent_client_protocol::schema::v1::{ContentBlock, TextContent};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vst_proc::sq;
use vst_types::{Channel, NormalizedEvent, NormalizedEventKind, NormalizedEventProvider};

use crate::acp_connection::AcpLaunchSpec;
use crate::acp_run_turn::{run_turn_acp, RunTurnAcpParams};
use crate::claude::format_skill_directive;
use crate::plugin::{
    base_event, AgentPlugin, AsyncResult, CaptureArgs, ComposePromptInput, ComposePromptResult,
    LaunchConfig, ListModelsResult, PromptDelivery, ReadySignal, RestoreArgs, SkillInvocation,
    TurnContext, TurnInput,
};

/// oh-my-pi plugin.
pub struct OmpPlugin;

/// Create a fresh `omp` plugin instance.
pub fn create_omp_plugin() -> OmpPlugin {
    OmpPlugin
}

/// Per-session omp session store, `<cwd>/.vibe-station/omp-sessions/<sessionId>`
/// (inside `.vibe-station/`, gitignored by `setup_workspace_hooks`).
fn session_dir(cwd: &Path, session_id: &str) -> PathBuf {
    cwd.join(".vibe-station")
        .join("omp-sessions")
        .join(session_id)
}

/// omp's default session store, `<home>/.omp/agent/sessions` (or
/// `$PI_CODING_AGENT_DIR/sessions`; pattern: `pi.rs`'s `pi_sessions_root`).
fn omp_default_sessions_root() -> PathBuf {
    match std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|_| !crate::home::is_overridden())
        .filter(|v| !v.is_empty())
    {
        Some(dir) => PathBuf::from(dir).join("sessions"),
        None => crate::home::home_dir()
            .join(".omp")
            .join("agent")
            .join("sessions"),
    }
}

/// Find the conversation file for `chat_id` inside `dir` — the `*_<chat_id>.jsonl`
/// whose name suffix matches. omp names files `<timestamp>_<sessionId>.jsonl`, so
/// the id is matched by suffix, not by exact name.
fn find_conversation_in(dir: &Path, chat_id: &str) -> Option<PathBuf> {
    let suffix = format!("_{chat_id}.jsonl");
    let entries = std::fs::read_dir(dir).ok()?;
    entries.flatten().map(|e| e.path()).find(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(&suffix))
    })
}

/// The on-disk conversation for `chat_id`, wherever omp put it (Decision 6):
/// the per-vst private store first (omp writes here), then the default store's
/// `vst-links/` (a contended-writer sibling can land there as a REAL file, not
/// just the symlink the resume path creates). None when neither exists.
pub(crate) fn conversation_file(cwd: &Path, session_id: &str, chat_id: &str) -> Option<PathBuf> {
    find_conversation_in(&session_dir(cwd, session_id), chat_id)
        .or_else(|| find_conversation_in(&omp_default_sessions_root().join("vst-links"), chat_id))
}

/// Make session `chat_id` loadable by `omp acp`. `session/new` honours
/// `--session-dir` but `session/load` only scans omp's DEFAULT store (verified on
/// 18.12.6: "ACP session not found"), so without this a reconnect — including the
/// json→tty→json toggle — silently starts a fresh conversation. A file symlink
/// under `<default store>/vst-links/` is enough for the lookup, and omp keeps
/// appending through it, so the private store stays the single copy. Best effort:
/// failure only costs the resume (the session layer falls back to `session/new`).
fn link_into_default_store(cwd: &Path, session_id: &str, chat_id: &str) {
    // Only the private store matters here: omp appends through the link, so the
    // default store's `vst-links` entry, if present, is the symlink back to the
    // private file (linking it to itself would be a self-reference).
    let Some(file) = find_conversation_in(&session_dir(cwd, session_id), chat_id) else {
        return;
    };
    let links = omp_default_sessions_root().join("vst-links");
    let Some(name) = file.file_name() else {
        return;
    };
    let link = links.join(name);
    if std::fs::create_dir_all(&links).is_err() {
        return;
    }
    prune_dangling_links(&links);
    // Replace a stale link (the project may have moved). A REAL file here is a
    // conversation omp itself wrote (contended-writer sibling): never delete it.
    if let Ok(meta) = link.symlink_metadata() {
        if !meta.file_type().is_symlink() || std::fs::read_link(&link).is_ok_and(|t| t == file) {
            return;
        }
        let _ = std::fs::remove_file(&link);
    }
    let _ = std::os::unix::fs::symlink(&file, &link);
}

/// The per-session system prompt the daemon writes for every session
/// (`<session data dir>/system-prompt.md`) — the file `omp acp` is launched with.
fn shared_system_prompt_path(
    project_id: &str,
    worktree_id: Option<&str>,
    session_id: &str,
) -> PathBuf {
    let paths = crate::paths::Paths::default();
    match worktree_id {
        Some(w) => paths.system_prompt_path(project_id, w, session_id),
        None => paths.direct_system_prompt_path(project_id, session_id),
    }
}

/// Drop `vst-links` symlinks whose target is gone (worktree deleted), so the dir in
/// the user's omp store stays bounded. Real files and live links are left alone.
fn prune_dangling_links(links: &Path) {
    let Ok(entries) = std::fs::read_dir(links) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let dangling = path
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
            && std::fs::metadata(&path).is_err();
        if dangling {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Terminal-channel system-prompt file. omp rebuilds its system prompt on every
/// run, so a resume must pass the same file again or the vst instructions are lost.
fn system_prompt_path(cwd: &Path, session_id: &str) -> PathBuf {
    cwd.join(".vibe-station")
        .join("omp-system-prompt")
        .join(session_id)
}

/// The omp conversation in `dir` that has at least one user turn, as
/// its session id. omp writes a header (and a title slot) at startup, so a
/// file's existence alone is not proof a conversation began (cf.
/// `docs/CLI-LAUNCH-PITFALLS.md`). The newest such file wins.
///
/// Newest is judged by the filename's `<timestamp>_` prefix (lexical ISO
/// compare), NOT mtime: on a second writer omp appends `session_exit` to the
/// OLD file, so its mtime is newer than the conversation that replaced it.
/// mtime only breaks ties between identical timestamps (Decision 6).
fn started_conversation(dir: &Path) -> Option<String> {
    let mut best: Option<(String, std::time::SystemTime, String)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".jsonl") else {
            continue;
        };
        // `<timestamp>_<sessionId>`; ids are UUIDs, so split on the first `_`.
        let Some((ts, id)) = stem.split_once('_') else {
            continue;
        };
        if id.is_empty() || !file_has_user_turn(&entry.path()) {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        let newer = best.as_ref().map_or(true, |(t, m, _)| {
            t.as_str() < ts || (t.as_str() == ts && mtime > *m)
        });
        if newer {
            best = Some((ts.to_string(), mtime, id.to_string()));
        }
    }
    best.map(|(_, _, id)| id)
}

/// Whether an omp session `.jsonl` holds a user `message` entry. Parsed
/// tolerantly: the role may sit at `/message/role` or `/role`, and non-JSON
/// lines (the fixed-width title slot may be padded) are skipped.
fn file_has_user_turn(path: &Path) -> bool {
    use std::io::{BufRead, BufReader};
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    // Stream line by line: stops at the first user message, never buffers the
    // whole file, and tolerates non-UTF-8 bytes elsewhere in it.
    BufReader::new(file)
        .split(b'\n')
        .map_while(Result::ok)
        .any(|line| {
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(&line) else {
                return false;
            };
            v.get("type").and_then(|t| t.as_str()) == Some("message")
                && v.pointer("/message/role")
                    .or_else(|| v.get("role"))
                    .and_then(|r| r.as_str())
                    == Some("user")
        })
}

/// Flags shared by the TUI and `omp acp` launches: unattended approvals, the
/// per-session store and (when set) the model. `--approval-mode yolo` (not
/// `--yolo`, which is only a docs alias) auto-approves so vst agents run
/// unattended; `--allow-home` lets omp run when `cwd` is `$HOME` (omp refuses
/// to operate on the home directory otherwise).
fn common_args(cwd: &Path, session_id: &str, model: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "--approval-mode".to_string(),
        "yolo".to_string(),
        "--allow-home".to_string(),
        "--session-dir".to_string(),
        session_dir(cwd, session_id).to_string_lossy().into_owned(),
    ];
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    args
}

impl AgentPlugin for OmpPlugin {
    fn name(&self) -> &str {
        "omp"
    }

    fn default_channel(&self) -> Channel {
        Channel::Json
    }

    /// Empty = no explicit model: omp is multi-provider, so it uses whatever the
    /// user configured. A hardcoded id could name a provider they don't have.
    fn default_model(&self) -> &str {
        ""
    }

    /// Model-aware like opencode's: omp is multi-provider, so a DeepSeek model
    /// (case-insensitive) gets the DeepSeek mark, anything else omp's own.
    fn default_mode_icon(&self, model: Option<&str>) -> &'static str {
        match model {
            Some(m) if m.to_ascii_lowercase().contains("deepseek") => "deepseek",
            _ => "omp",
        }
    }

    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::Inline
    }

    fn setup_workspace_hooks(&self, workspace_path: &str) -> AsyncResult<()> {
        // At `$HOME` there is no repo to host the gitignore entry, and editing
        // the user's home `.gitignore` would be unexpected (the store still
        // lives under `<cwd>/.vibe-station/`; omp handles cwd=$HOME via
        // `--allow-home`). The comparison is literal — a worktree path is
        // never `$HOME` itself.
        if workspace_path == crate::home::home_dir().to_string_lossy() {
            return Box::pin(async {});
        }
        let gitignore = PathBuf::from(workspace_path).join(".gitignore");
        Box::pin(async move {
            crate::codex::ensure_gitignore_entry(gitignore, ".vibe-station/").await;
        })
    }

    fn get_launch_command(&self, cfg: &LaunchConfig) -> Vec<String> {
        let mut argv = vec!["omp".to_string()];
        argv.extend(common_args(
            &cfg.ctx.cwd,
            &cfg.session.id,
            cfg.model.as_deref(),
        ));
        // Re-launch of a session that already has a conversation continues it.
        if let Some(id) = started_conversation(&session_dir(&cfg.ctx.cwd, &cfg.session.id)) {
            argv.push("--resume".to_string());
            argv.push(id);
        }
        argv
    }

    fn get_environment(&self, _cfg: &LaunchConfig) -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    fn get_ready_signal(&self) -> ReadySignal {
        ReadySignal {
            sentinel: None,
            fallback_ms: 12_000,
        }
    }

    fn compose_launch_prompt(&self, input: ComposePromptInput) -> ComposePromptResult {
        if input.task_prompt.is_none() && input.system_prompt.is_empty() {
            return ComposePromptResult::default();
        }
        let cfg = &input.launch_cfg;
        let dir = PathBuf::from(&input.system_prompt_file)
            .parent()
            .map(PathBuf::from)
            .unwrap_or_default();
        let mut shell_line = "omp".to_string();
        for arg in common_args(&cfg.ctx.cwd, &cfg.session.id, cfg.model.as_deref()) {
            shell_line.push(' ');
            shell_line.push_str(&sq(&arg));
        }
        // The system prompt rides omp's own flag (it reads the file when the
        // argument is a path), which keeps a large prompt off tmux's ~16 KB limit.
        if !input.system_prompt.is_empty() {
            let file = system_prompt_path(&cfg.ctx.cwd, &cfg.session.id);
            let written = file
                .parent()
                .is_some_and(|d| std::fs::create_dir_all(d).is_ok())
                && std::fs::write(&file, &input.system_prompt).is_ok();
            if written {
                shell_line.push_str(&format!(
                    " --append-system-prompt {}",
                    sq(&file.to_string_lossy())
                ));
            }
        }
        if let Some(task) = &input.task_prompt {
            let file = dir.join("task_prompt.txt");
            let _ = std::fs::write(&file, task);
            shell_line.push_str(&format!(" \"$(cat {})\"", sq(&file.to_string_lossy())));
        }
        ComposePromptResult {
            use_shell: true,
            shell_line: Some(shell_line),
            ..Default::default()
        }
    }

    fn list_models(&self) -> AsyncResult<ListModelsResult> {
        Box::pin(async {
            let run = tokio::process::Command::new("omp")
                .args(["models", "--json"])
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true)
                .output();
            let fail = |msg: String| ListModelsResult {
                models: vec![],
                error: Some(msg),
            };
            match tokio::time::timeout(std::time::Duration::from_secs(20), run).await {
                Err(_) => fail("`omp models --json` timed out after 20s.".to_string()),
                Ok(Err(e)) => fail(format!(
                    "Couldn't run `omp models --json`: {e}. Check that omp is installed and on the daemon's PATH."
                )),
                Ok(Ok(out)) if !out.status.success() => fail(format!(
                    "`omp models --json` failed ({}). Check that omp is installed.",
                    String::from_utf8_lossy(&out.stderr).trim()
                )),
                Ok(Ok(out)) => {
                    let models = parse_omp_models(&String::from_utf8_lossy(&out.stdout));
                    if models.is_empty() {
                        fail("`omp models --json` returned no models. Sign in to a provider in omp (`omp login`).".to_string())
                    } else {
                        ListModelsResult {
                            models,
                            error: None,
                        }
                    }
                }
            }
        })
    }

    /// The id of this session's own conversation, read from its private store.
    /// Only reported once a user turn exists, so a session that never started a
    /// conversation doesn't record an id for a resume that would replay nothing.
    fn capture_chat_id(&self, args: CaptureArgs<'_>) -> AsyncResult<Option<String>> {
        let dir = session_dir(Path::new(args.cwd), &args.session.id);
        Box::pin(async move {
            tokio::task::spawn_blocking(move || started_conversation(&dir))
                .await
                .ok()
                .flatten()
        })
    }

    /// tty→json toggle: recompute the newest conversation in the store. omp
    /// mints its own id (no "create with this id" forge), and the terminal
    /// may have moved to a new id on a second writer, so re-scan rather than
    /// trust the stored id. Same body as `capture_chat_id`.
    fn refresh_chat_id_on_toggle(&self, args: CaptureArgs<'_>) -> AsyncResult<Option<String>> {
        self.capture_chat_id(args)
    }

    /// Whether this session's store holds any started omp conversation (≥1 user turn on disk).
    fn chat_established(&self, args: RestoreArgs<'_>) -> AsyncResult<bool> {
        let dir = session_dir(Path::new(args.cwd), &args.session.id);
        Box::pin(async move {
            tokio::task::spawn_blocking(move || started_conversation(&dir).is_some())
                .await
                .unwrap_or(false)
        })
    }

    fn get_restore_command(&self, args: RestoreArgs<'_>) -> AsyncResult<Option<Vec<String>>> {
        let cwd = PathBuf::from(args.cwd);
        let session_id = args.session.id.clone();
        let model = args.model.map(str::to_string);
        let shared_prompt = shared_system_prompt_path(
            &args.session.project_id,
            args.session.worktree_id.as_deref(),
            &session_id,
        );
        Box::pin(async move {
            let dir = session_dir(&cwd, &session_id);
            // No user turn ⇒ nothing to resume; the caller re-launches fresh and
            // re-delivers the initial prompt.
            let id = tokio::task::spawn_blocking(move || started_conversation(&dir))
                .await
                .ok()
                .flatten()?;
            let mut argv = vec!["omp".to_string()];
            argv.extend(common_args(&cwd, &session_id, model.as_deref()));
            argv.push("--resume".to_string());
            argv.push(id);
            // omp rebuilds its system prompt on every run, so the resume must pass it
            // again. The shared per-session file is written for EVERY session (it is
            // what `omp acp` gets); the tty-only copy exists only after a fresh
            // terminal launch, so a Rich Chat -> Terminal toggle would otherwise
            // lose the vst instructions.
            let prompt_file = [shared_prompt, system_prompt_path(&cwd, &session_id)]
                .into_iter()
                .find(|p| p.is_file());
            if let Some(prompt_file) = prompt_file {
                argv.push("--append-system-prompt".to_string());
                argv.push(prompt_file.to_string_lossy().into_owned());
            }
            Some(argv)
        })
    }

    fn supports_json(&self) -> bool {
        true
    }

    fn supports_acp(&self) -> bool {
        true
    }

    fn native_history_importer(
        &self,
    ) -> Option<&'static dyn crate::native_history_importer::NativeHistoryImporter> {
        Some(crate::omp_import::omp_history_importer())
    }

    /// `identical`: the ACP `session/new` id is omp's own resume id (the
    /// `<ts>_<id>.jsonl` suffix), so after a tty→json toggle refreshes
    /// `agent_chat_id` the daemon may drop a stale stored `acp_session_id`
    /// (which would otherwise win on reconnect). Decision 5.
    fn acp_session_id_is_native(&self) -> bool {
        true
    }

    /// Mid-turn steering is verified end-to-end for omp (both gates hold:
    /// `_meta.steering.supported` in `initialize`, and our opt-in — the
    /// BANANA probe, `docs/RICH-CHAT-ACP.md` §7 / Decision 3). The injected
    /// user message is persisted and answered by the model, unlike opencode.
    fn supports_mid_turn_steering(&self) -> bool {
        true
    }

    fn format_skill_directive(
        &self,
        message: &str,
        skill_invocations: Option<&[SkillInvocation]>,
    ) -> String {
        format_skill_directive(message, skill_invocations)
    }

    fn run_turn(
        &self,
        input: TurnInput,
        ctx: TurnContext,
        cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let params = RunTurnAcpParams {
            provider: NormalizedEventProvider::Omp,
            build_spec: Box::new(|ctx| {
                // Launch flags are forwarded to `omp acp`. `--yolo` matters here:
                // vst agents run unattended, so no ACP permission card could be
                // answered. The model rides `--model` (read at process start).
                let mut args = vec!["acp".to_string()];
                args.extend(common_args(&ctx.cwd, &ctx.session.id, ctx.model.as_deref()));
                if ctx.system_prompt_file.is_file() {
                    args.push("--append-system-prompt".to_string());
                    args.push(ctx.system_prompt_file.to_string_lossy().into_owned());
                }
                AcpLaunchSpec {
                    command: "omp".to_string(),
                    args,
                    cwd: ctx.cwd.clone(),
                    env: Default::default(),
                    initialize_timeout_ms: None,
                    prompt_timeout_ms: None,
                    reap_detached_descendants: false,
                }
            }),
            enrich: None,
            // `identical`: the ACP session id is omp's resume id.
            first_turn_session_init: Some(Arc::new(|ctx, acp_id| {
                let mut ev = base_event(
                    &ctx.session.id,
                    NormalizedEventProvider::Omp,
                    NormalizedEventKind::SessionInit,
                );
                ev.agent_chat_id = Some(acp_id.to_string());
                ev
            })),
            // The system prompt reaches omp via `--append-system-prompt`, not a block.
            build_prompt_blocks: Box::new(|_ctx, input, _system| {
                vec![ContentBlock::Text(TextContent::new(input.message.clone()))]
            }),
            emit_refusal_error: false,
            stuck_turn_idle_ms: None,
            stuck_turn_cancel_grace_ms: None,
        };
        // Reconnect loads `acp_session_id` first, else `agent_chat_id` (see
        // `json_agent_session/connection.rs`); make that id visible to `omp acp`.
        let resume_id = ctx
            .session
            .acp_session_id
            .clone()
            .or_else(|| ctx.session.agent_chat_id.clone());
        let (cwd, session_id) = (ctx.cwd.clone(), ctx.session.id.clone());
        tokio::spawn(async move {
            if let Some(id) = resume_id.filter(|id| !id.is_empty()) {
                let _ = tokio::task::spawn_blocking(move || {
                    link_into_default_store(&cwd, &session_id, &id)
                })
                .await;
            }
            run_turn_acp(tx, input, ctx, cancel, params).await;
        });
        rx
    }
}

/// Parse `omp models --json` into `provider/model` ids. The exact shape isn't
/// documented, so this accepts a bare array or an object wrapping one (under any
/// key), and entries naming the model by `id`/`model`/`slug` with an optional
/// `provider`. An id already containing `/` is kept as is. Dupes are dropped.
pub(crate) fn parse_omp_models(json: &str) -> Vec<String> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(json.trim()) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    collect_models(&root, None, &mut out);
    out
}

fn collect_models(v: &serde_json::Value, provider: Option<&str>, out: &mut Vec<String>) {
    match v {
        serde_json::Value::Array(items) => {
            for item in items {
                collect_models(item, provider, out);
            }
        }
        serde_json::Value::Object(map) => {
            // Entries that aren't chat models (image/embedding models) are not
            // promptable — skip them outright.
            if let Some(kind) = map.get("kind").and_then(|k| k.as_str()) {
                if kind != "chat" {
                    return;
                }
            }
            let own_provider = map.get("provider").and_then(|p| p.as_str()).or(provider);
            // Prefer `selector` (omp's fully-qualified `provider/id` name, and
            // what `--model` expects) when present; fall back to `id`/`model`/
            // `slug`. A `selector` already carrying `/` is kept as is.
            let id = map
                .get("selector")
                .or_else(|| ["id", "model", "slug"].iter().find_map(|k| map.get(*k)))
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty());
            if let Some(id) = id {
                let full = match own_provider {
                    Some(p) if !id.contains('/') => format!("{p}/{id}"),
                    _ => id.to_string(),
                };
                if !out.contains(&full) {
                    out.push(full);
                }
            } else {
                // Provider-grouped: `{ "anthropic": [...] }` or `{ "models": [...] }`.
                for (k, child) in map {
                    let group = if child.is_array() {
                        Some(k.as_str())
                    } else {
                        None
                    };
                    collect_models(
                        child,
                        group.filter(|g| *g != "models").or(own_provider),
                        out,
                    );
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> PathBuf {
        // A counter, not just the clock: two calls in one test can land on the
        // same clock tick and would share (then double-delete) a directory.
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "vst-omp-{}-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn conversation_needs_a_user_turn() {
        let dir = tmp();
        // Title slot + header only: not started.
        fs::write(
            dir.join("1700_abc.jsonl"),
            "{\"type\":\"title\"}\n{\"type\":\"session\",\"id\":\"abc\"}\n",
        )
        .unwrap();
        assert_eq!(started_conversation(&dir), None);
        fs::write(
            dir.join("1700_abc.jsonl"),
            "{\"type\":\"session\",\"id\":\"abc\"}\n{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
        )
        .unwrap();
        assert_eq!(started_conversation(&dir).as_deref(), Some("abc"));
        assert_eq!(started_conversation(&dir.join("missing")), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn links_session_file_into_default_store_for_acp_load() {
        let home = tmp();
        let _guard = crate::home::with_home(home.clone());
        let cwd = tmp();
        let dir = session_dir(&cwd, "s1");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("2026-10-22T10-00-00-000Z_abc.jsonl");
        fs::write(&file, "{}\n").unwrap();

        link_into_default_store(&cwd, "s1", "abc");
        let link = omp_default_sessions_root()
            .join("vst-links")
            .join("2026-10-22T10-00-00-000Z_abc.jsonl");
        assert_eq!(fs::read_link(&link).unwrap(), file);
        // Idempotent, and a different id (no file) is a no-op.
        link_into_default_store(&cwd, "s1", "abc");
        link_into_default_store(&cwd, "s1", "missing");
        assert_eq!(fs::read_dir(link.parent().unwrap()).unwrap().count(), 1);
        // A dangling link to a moved project is replaced.
        let moved = tmp();
        let moved_dir = session_dir(&moved, "s1");
        fs::create_dir_all(&moved_dir).unwrap();
        let moved_file = moved_dir.join("2026-10-22T10-00-00-000Z_abc.jsonl");
        fs::write(&moved_file, "{}\n").unwrap();
        link_into_default_store(&moved, "s1", "abc");
        assert_eq!(fs::read_link(&link).unwrap(), moved_file);
        for d in [home, cwd, moved] {
            fs::remove_dir_all(d).unwrap();
        }
    }

    /// Decision 6: `conversation_file` prefers the private store, then finds a
    /// conversation in the default store's `vst-links/` even when the entry there
    /// is a REAL file (a contended-writer sibling lands there as a copy, not a
    /// symlink).
    #[test]
    fn conversation_file_prefers_private_then_finds_regular_vst_link() {
        let home = tmp();
        let _guard = crate::home::with_home(home.clone());
        let cwd = tmp();
        // Nothing anywhere yet.
        assert_eq!(conversation_file(&cwd, "s1", "abc"), None);
        // Default-store, real file only -> found in vst-links (the private store
        // has no copy).
        let links = omp_default_sessions_root().join("vst-links");
        fs::create_dir_all(&links).unwrap();
        let linked = links.join("2026-10-22T10-00-00-000Z_abc.jsonl");
        fs::write(&linked, "{}\n").unwrap();
        assert_eq!(
            conversation_file(&cwd, "s1", "abc").as_deref(),
            Some(linked.as_path())
        );
        // A private-store copy shadows the default-store one.
        let dir = session_dir(&cwd, "s1");
        fs::create_dir_all(&dir).unwrap();
        let private = dir.join("2026-10-22T11-00-00-000Z_abc.jsonl");
        fs::write(&private, "{}\n").unwrap();
        assert_eq!(
            conversation_file(&cwd, "s1", "abc").as_deref(),
            Some(private.as_path())
        );
        assert_eq!(conversation_file(&cwd, "s1", "missing"), None);
        for d in [home, cwd] {
            fs::remove_dir_all(d).unwrap();
        }
    }

    #[test]
    fn link_never_deletes_a_real_file_and_prunes_dangling_links() {
        let home = tmp();
        let _guard = crate::home::with_home(home.clone());
        let cwd = tmp();
        let dir = session_dir(&cwd, "s1");
        fs::create_dir_all(&dir).unwrap();
        let name = "2026-10-22T10-00-00-000Z_abc.jsonl";
        fs::write(dir.join(name), "{}\n").unwrap();
        let links = omp_default_sessions_root().join("vst-links");
        fs::create_dir_all(&links).unwrap();
        // A real file omp wrote at the link path is left untouched.
        fs::write(links.join(name), "REAL").unwrap();
        // A dangling link from a deleted worktree is pruned.
        std::os::unix::fs::symlink(cwd.join("gone.jsonl"), links.join("old_x.jsonl")).unwrap();

        link_into_default_store(&cwd, "s1", "abc");
        assert_eq!(fs::read_to_string(links.join(name)).unwrap(), "REAL");
        assert!(links.join("old_x.jsonl").symlink_metadata().is_err());
        for d in [home, cwd] {
            fs::remove_dir_all(d).unwrap();
        }
    }

    #[test]
    fn user_turn_scan_survives_invalid_utf8_elsewhere() {
        let dir = tmp();
        let mut bytes = b"{\"type\":\"custom\",\"data\":\"".to_vec();
        bytes.extend_from_slice(&[0xff, 0xfe]);
        bytes.extend_from_slice(b"\"}\n{\"type\":\"message\",\"message\":{\"role\":\"user\"}}\n");
        fs::write(dir.join("1_x.jsonl"), bytes).unwrap();
        assert_eq!(started_conversation(&dir).as_deref(), Some("x"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn default_mode_icon_is_model_aware() {
        let p = OmpPlugin;
        assert_eq!(
            p.default_mode_icon(Some("deepseek-local/DeepSeek-V4.1-Flash-1017")),
            "deepseek"
        );
        assert_eq!(p.default_mode_icon(Some("DEEPSEEK-R1")), "deepseek");
        assert_eq!(p.default_mode_icon(Some("anthropic/claude-opus-4")), "omp");
        assert_eq!(p.default_mode_icon(None), "omp");
    }

    #[test]
    fn assistant_only_is_not_started() {
        let dir = tmp();
        fs::write(
            dir.join("1_x.jsonl"),
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\"}}\n",
        )
        .unwrap();
        assert_eq!(started_conversation(&dir), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn common_args_pin_store_and_model() {
        let args = common_args(Path::new("/w"), "s1", Some("anthropic/claude"));
        assert_eq!(
            &args[0..4],
            ["--approval-mode", "yolo", "--allow-home", "--session-dir"]
        );
        assert_eq!(args[4], "/w/.vibe-station/omp-sessions/s1");
        assert_eq!(&args[5..], ["--model", "anthropic/claude"]);
        assert_eq!(common_args(Path::new("/w"), "s1", Some("")).len(), 5);
    }

    #[test]
    fn parses_flat_array_with_provider() {
        let json = r#"[{"provider":"anthropic","id":"claude-opus"},{"provider":"openai","id":"gpt-5"},{"provider":"openai","id":"gpt-5"}]"#;
        assert_eq!(
            parse_omp_models(json),
            vec!["anthropic/claude-opus", "openai/gpt-5"]
        );
    }

    #[test]
    fn parses_provider_grouped_object() {
        let json = r#"{"models":{"anthropic":[{"id":"claude-opus"}],"openai":[{"id":"gpt-5"}]}}"#;
        assert_eq!(
            parse_omp_models(json),
            vec!["anthropic/claude-opus", "openai/gpt-5"]
        );
    }

    #[test]
    fn keeps_slashed_ids_and_ignores_garbage() {
        assert_eq!(
            parse_omp_models(r#"[{"provider":"x","id":"openai/gpt-5"}]"#),
            vec!["openai/gpt-5"]
        );
        assert!(parse_omp_models("not json").is_empty());
        assert!(parse_omp_models("[]").is_empty());
    }

    #[test]
    fn prefers_selector_and_skips_non_chat_kinds() {
        let json = r#"[
            {"provider":"deepseek-local","kind":"chat","id":"deepseek-v4","selector":"deepseek-local/deepseek-v4"},
            {"provider":"openai","kind":"image","id":"gpt-image-1","selector":"openai/gpt-image-1"},
            {"provider":"anthropic","kind":"chat","id":"claude-opus","selector":"anthropic/claude-opus"}
        ]"#;
        assert_eq!(
            parse_omp_models(json),
            vec!["deepseek-local/deepseek-v4", "anthropic/claude-opus"]
        );
    }

    /// Real `omp models --json` output (v18.12.6) — see
    /// `tests/fixtures/omp/models-18.12.6.json`. Chat models surface their
    /// `selector`; the image model (`kind != "chat"`) is dropped.
    #[test]
    fn parses_fixture_models_18_12_6() {
        let json = include_str!("../tests/fixtures/omp/models-18.12.6.json");
        assert_eq!(
            parse_omp_models(json),
            vec![
                "deepseek-local/deepseek-v4-flash-0731",
                "anthropic/claude-opus-4-1"
            ]
        );
    }

    /// M1: a second writer appends `session_exit` to the OLD file, refreshing
    /// its mtime — so `started_conversation` must order by the filename
    /// timestamp, not mtime (Decision 6).
    #[test]
    fn newest_conversation_by_filename_timestamp_not_mtime() {
        let dir = tmp();
        // Write the newer-timestamp file FIRST, then the older one, so the old
        // file's mtime is the newest. `new` must still win its filename prefix.
        let new = dir.join("2000_new.jsonl");
        fs::write(
            &new,
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
        )
        .unwrap();
        let old = dir.join("1000_old.jsonl");
        fs::write(
            &old,
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
        )
        .unwrap();
        // Both have user turns; the older-timestamp file was touched last.
        assert_eq!(started_conversation(&dir).as_deref(), Some("new"));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// `refresh_chat_id_on_toggle` re-scans the store and returns the newest
    /// conversation (the terminal may have moved to a new id).
    #[tokio::test]
    async fn refresh_returns_newest_id() {
        let base = tmp();
        let cwd = base.join("cwd");
        fs::create_dir_all(&cwd).unwrap();
        let store = session_dir(&cwd, "s1");
        fs::create_dir_all(&store).unwrap();
        fs::write(
            store.join("1000_first.jsonl"),
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
        )
        .unwrap();
        let plugin = OmpPlugin;
        let session = vst_types::SessionRecord {
            id: "s1".into(),
            ..make_session()
        };
        let project = make_project();
        let capture = || CaptureArgs {
            session: &session,
            project: &project,
            cwd: cwd.to_str().unwrap(),
            worktree: None,
        };
        assert_eq!(
            plugin.capture_chat_id(capture()).await.as_deref(),
            Some("first")
        );
        // The terminal moved to a NEW id (e.g. a second writer); refresh must
        // pick it up rather than trust the stored id.
        fs::write(
            store.join("2000_second.jsonl"),
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
        )
        .unwrap();
        assert_eq!(
            plugin.refresh_chat_id_on_toggle(capture()).await.as_deref(),
            Some("second")
        );
        fs::remove_dir_all(&base).unwrap();
    }

    fn make_session() -> vst_types::SessionRecord {
        vst_types::SessionRecord {
            id: String::new(),
            worktree_id: None,
            project_id: "p1".into(),
            is_main: false,
            sort_order: 0.0,
            r#type: vst_types::SessionType::Agent,
            mode_id: None,
            mode_icon: None,
            name: None,
            name_source: None,
            tmux_name: String::new(),
            use_tmux: true,
            channel: None,
            lifecycle: vst_types::SessionLifecycle {
                state: vst_types::LifecycleState::Working,
                reason: None,
                last_transition_at: "2026-01-01T00:00:00.000Z".into(),
            },
            transcript_ref: None,
            agent_chat_id: None,
            acp_session_id: None,
            model_override: None,
            pinned_at: None,
            initial_prompt: None,
            draft_prompt: None,
            draft_config: None,
            archived_at: None,
            handoff_summary: None,
            carry_over: None,
            parent_session_id: None,
            superseded_by: None,
            pr: None,
            last_activity_at: None,
            last_line: None,
            last_tool: None,
        }
    }

    fn make_project() -> vst_types::ProjectRecord {
        vst_types::ProjectRecord {
            id: "p1".into(),
            absolute_path: "/repos/p1".into(),
            prefix: "vs".into(),
            is_git: true,
            default_branch: Some("main".into()),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            hidden: None,
            direct_sessions: vec![],
            direct_session_seq: None,
            worktrees: vec![],
            next_worktree_num: None,
            lsp_enabled: None,
            open_files: vec![],
        }
    }
}
