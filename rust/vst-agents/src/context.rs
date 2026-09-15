//! Agent context — the thing an agent session runs *in* (ports
//! `services/context.ts`). Completes the direct-vs-worktree resolution and the
//! VST_* env builder that `paths.rs` (the path-derivation half, adopted from
//! 04a) does not cover. A direct context resolves to its project — no
//! fabricated worktree, no null to misread.

use std::collections::HashMap;

use vst_types::{ProjectRecord, SessionRecord, WorktreeRecord};

use crate::home::home_dir;
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
    let vst_skill_path = home_dir()
        .join(".vibe-station")
        .join("skill")
        .join("vst")
        .join("SKILL.md")
        .display()
        .to_string();
    let vst_data_dir = format!(
        "{}/.vibe-station/projects/{}",
        home_dir().display(),
        opts.project.id
    );
    let path_env = format!(
        "{vst_bin_dir}:{}",
        std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_string())
    );

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
    env.insert("VST_SKILL_PATH".to_string(), vst_skill_path);
    env
}
