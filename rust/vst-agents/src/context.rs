//! Agent context — the thing an agent session runs *in* (ports
//! `services/context.ts`). Completes the direct-vs-worktree resolution and the
//! VST_* env builder that `paths.rs` (the path-derivation half, adopted from
//! 04a) does not cover. A direct context resolves to its project — no
//! fabricated worktree, no null to misread.

use std::collections::HashMap;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

use vst_types::{ProjectRecord, SessionRecord, WorktreeRecord};

use crate::home::{home_dir, is_overridden};
use crate::paths::Paths;

/// Serializable reference to a context. Carries projectId in both shapes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentContextRef {
    Worktree {
        project_id: String,
        worktree_id: String,
    },
    Project {
        project_id: String,
    },
}

/// A ref resolved against the project store. Never persisted — always computed.
pub struct ResolvedContext {
    pub ref_: AgentContextRef,
    pub project: ProjectRecord,
    /// None ⇔ ref is Project. Gate on this; never fabricate one.
    pub worktree: Option<WorktreeRecord>,
    /// Where the agent actually runs: the worktree checkout, or the project dir.
    pub cwd: String,
}

/// Resolve directly from records already in hand — the only resolver the spawn
/// and resume paths need.
pub fn resolved_context_of(
    project: ProjectRecord,
    worktree: Option<WorktreeRecord>,
) -> ResolvedContext {
    let paths = Paths::default();
    let (ref_, cwd) = match &worktree {
        Some(w) => (
            AgentContextRef::Worktree {
                project_id: project.id.clone(),
                worktree_id: w.id.clone(),
            },
            paths
                .project_dir(&project.id)
                .join("worktrees")
                .join(&w.id)
                .display()
                .to_string(),
        ),
        None => (
            AgentContextRef::Project {
                project_id: project.id.clone(),
            },
            project.absolute_path.clone(),
        ),
    };
    ResolvedContext {
        ref_,
        project,
        worktree,
        cwd,
    }
}

/// Per-session data dir for this context (routes to worktree or direct family).
pub fn session_data_dir_for(ctx: &ResolvedContext, session_id: &str) -> String {
    let paths = Paths::default();
    match &ctx.worktree {
        Some(w) => paths
            .session_data_dir(&ctx.project.id, &w.id, session_id)
            .display()
            .to_string(),
        None => paths
            .direct_session_data_dir(&ctx.project.id, session_id)
            .display()
            .to_string(),
    }
}

/// `<sessionDataDir>/system-prompt.md` for this context.
pub fn system_prompt_path_for(ctx: &ResolvedContext, session_id: &str) -> String {
    let paths = Paths::default();
    match &ctx.worktree {
        Some(w) => paths
            .system_prompt_path(&ctx.project.id, &w.id, session_id)
            .display()
            .to_string(),
        None => paths
            .direct_system_prompt_path(&ctx.project.id, session_id)
            .display()
            .to_string(),
    }
}

/// `<sessionDataDir>/opencode-config.json` for this context.
pub fn opencode_config_path_for(ctx: &ResolvedContext, session_id: &str) -> String {
    let paths = Paths::default();
    match &ctx.worktree {
        Some(w) => paths
            .opencode_config_path(&ctx.project.id, &w.id, session_id)
            .display()
            .to_string(),
        None => paths
            .direct_opencode_config_path(&ctx.project.id, session_id)
            .display()
            .to_string(),
    }
}

/// Fallback PATH when the daemon's `PATH` env var is absent.
const FALLBACK_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

/// Marker delimiters wrapping the `$PATH` value printed by the captured
/// interactive shell (Decision 2). Guard against rc-file noise on stdout.
const PATH_MARKER: &str = "__VST_PATH__";

/// Cached effective PATH (daemon PATH + unseen interactive-shell dirs). Warmed
/// on daemon startup (1.5) so the 5s shell capture never blocks a spawn.
static EFFECTIVE_PATH: OnceLock<String> = OnceLock::new();

/// The effective `PATH` an agent process should run under: the daemon's own
/// `PATH` first (order wins), with directories from the user's interactive
/// shell appended when they are not already present. Computed once and cached;
/// see `capture_shell_path` for the capture rules.
pub fn effective_path() -> String {
    EFFECTIVE_PATH.get_or_init(capture_effective_path).clone()
}

/// Merge `extra` into `base`, keeping `base`'s order (daemon PATH wins) and
/// appending unseen `extra` dirs. Empty and relative entries (`.`, `bin`, …)
/// are dropped; entries are deduped keeping the first occurrence.
pub fn merge_paths(base: &str, extra: &str) -> String {
    let mut seen: Vec<String> = Vec::new();
    let mut push = |entry: &str| {
        let entry = entry.trim();
        if entry.is_empty() || !entry.starts_with('/') {
            return;
        }
        if !seen.iter().any(|s| s == entry) {
            seen.push(entry.to_string());
        }
    };
    for e in base.split(':') {
        push(e);
    }
    for e in extra.split(':') {
        push(e);
    }
    seen.join(":")
}

/// Extract the `$PATH` value from a `$SHELL -ilc` capture, ignoring any noise
/// printed before/after the `__VST_PATH__...__VST_PATH__` markers. Returns
/// `None` when no marker pair is present or the captured path is empty.
pub fn parse_marked_path(output: &str) -> Option<String> {
    let start = output.find(PATH_MARKER)?;
    let rest = &output[start + PATH_MARKER.len()..];
    let end = rest.find(PATH_MARKER)?;
    let path = &rest[..end];
    if path.trim().is_empty() {
        return None;
    }
    Some(path.to_string())
}

/// Capture the user's interactive-shell PATH once (`$SHELL -ilc`, own process
/// group, 5s thread timeout, stdin/stderr nulled). On any failure (SHELL
/// unset, overridden home, timeout, non-zero) falls back to the daemon PATH.
fn capture_shell_path() -> Option<String> {
    if is_overridden() {
        return None;
    }
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;

    let mut child = Command::new(&shell)
        .args(["-ilc", r#"printf '__VST_PATH__%s__VST_PATH__' "$PATH""#])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .process_group(0)
        .spawn()
        .ok()?;

    let stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        let mut reader = std::io::BufReader::new(stdout);
        let _ = reader.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });

    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(out) => {
            let _ = child.wait();
            parse_marked_path(&out)
        }
        Err(_) => {
            // Timeout: kill the whole process group (a hung rc file or a
            // backgrounded grandchild holding stdout). `kill -- -<pgid>`
            // through Command, not libc (crate forbids unsafe).
            let _ = Command::new("kill")
                .args(["--", &format!("-{}", child.id())])
                .output();
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

fn capture_effective_path() -> String {
    let daemon_path = std::env::var("PATH").unwrap_or_else(|_| FALLBACK_PATH.to_string());
    let shell_path = capture_shell_path();
    merge_paths(&daemon_path, shell_path.as_deref().unwrap_or(""))
}

/// Options for `build_vst_env`.
pub struct BuildVstEnvOptions {
    pub project: ProjectRecord,
    /// None for a direct session — VST_WORKTREE is omitted entirely.
    pub worktree: Option<WorktreeRecord>,
    pub session: SessionRecord,
    pub daemon_port: u16,
}

/// The single source of "which VST_* vars does an agent process get"
/// (subagent-ux-v2 Decision 1). Callers merge this UNDER their plugin's own
/// env so the plugin keeps the last word on its own vars.
pub fn build_vst_env(opts: &BuildVstEnvOptions) -> HashMap<String, String> {
    let vst_bin_dir = home_dir()
        .join(".vibe-station")
        .join("bin")
        .display()
        .to_string();
    let vst_data_dir = format!(
        "{}/.vibe-station/projects/{}",
        home_dir().display(),
        opts.project.id
    );
    // effective_path() excludes the vst bin dir (which daemon PATH may not
    // contain); prepend it here so it always wins for vst's own shims.
    let path_env = format!("{vst_bin_dir}:{}", effective_path());

    let mut env = HashMap::new();
    env.insert("VST_SESSION".to_string(), opts.session.id.clone());
    env.insert("VST_SPAWN_TOKEN".to_string(), opts.session.id.clone());
    if let Some(w) = &opts.worktree {
        env.insert("VST_WORKTREE".to_string(), w.id.clone());
    }
    env.insert("VST_PROJECT".to_string(), opts.project.id.clone());
    env.insert("VST_DATA_DIR".to_string(), vst_data_dir);
    // Never emit port 0: a caller with no live server handle passes 0, and an
    // agent with VST_DAEMON_URL=http://127.0.0.1:0 cannot reach the daemon.
    // resolveDaemonPort() falls back to the registered/persisted port — that
    // registry lives daemon-side; here we only emit a URL for a live port.
    if opts.daemon_port > 0 {
        env.insert(
            "VST_DAEMON_URL".to_string(),
            format!("http://127.0.0.1:{}", opts.daemon_port),
        );
    }
    env.insert("PATH".to_string(), path_env);
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_paths_appends_unseen_and_dedupes() {
        assert_eq!(merge_paths("/a:/b", "/b:/c"), "/a:/b:/c");
    }

    #[test]
    fn merge_paths_empty_extra_returns_base() {
        assert_eq!(merge_paths("/a:/b", ""), "/a:/b");
    }

    #[test]
    fn merge_paths_drops_empty_and_relative_entries() {
        assert_eq!(merge_paths("/a::/b", "/c:.:bin"), "/a:/b:/c");
    }

    #[test]
    fn parse_marked_path_extracts_between_markers() {
        let out = "some rc noise\n__VST_PATH__/x:/y__VST_PATH__tail\n";
        assert_eq!(parse_marked_path(out), Some("/x:/y".to_string()));
    }

    #[test]
    fn parse_marked_path_no_markers_yields_none() {
        assert_eq!(parse_marked_path("no markers here"), None);
        assert_eq!(parse_marked_path(""), None);
    }

    #[test]
    fn parse_marked_path_empty_between_markers_yields_none() {
        assert_eq!(parse_marked_path("__VST_PATH____VST_PATH__"), None);
    }
}
