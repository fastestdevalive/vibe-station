//! 3-layer prompt builder per HIGH-LEVEL-DESIGN.md §4 (ports
//! `services/promptBuilder.ts`).
//!
//! L1 — base: `daemon/src/assets/agent-system-prompt.md` (embedded at compile
//! time, cached) + the Rich-Chat-only subagent fragment when `rich_chat`.
//! L2 — context: project + worktree + mode context.
//! L3 — rules: `<project>/AGENTS.md` or `<project>/.vibe-station/rules.md`.
//!
//! The L1/subagent assets are embedded via `include_str!` so the crate is
//! self-contained and tests are deterministic, while keeping the daemon's
//! asset files the single source of truth.

use std::sync::Mutex;

use vst_types::{LifecycleState, ProjectRecord, SessionType, WorktreeRecord};

// The daemon asset files, embedded once at compile time.
const SKILL_MD: &str = include_str!("../../../daemon/src/assets/agent-system-prompt.md");
const SUBAGENT_MD: &str = include_str!("../../../daemon/src/assets/agent-subagent-richchat.md");

static CACHED_SKILL_MD: Mutex<Option<String>> = Mutex::new(None);
static CACHED_SUBAGENT_MD: Mutex<Option<String>> = Mutex::new(None);

fn load_skill_md() -> String {
    let mut cache = CACHED_SKILL_MD.lock().unwrap();
    if let Some(c) = cache.as_ref() {
        return c.clone();
    }
    let content = SKILL_MD.to_string();
    *cache = Some(content.clone());
    content
}

fn load_subagent_md() -> String {
    let mut cache = CACHED_SUBAGENT_MD.lock().unwrap();
    if let Some(c) = cache.as_ref() {
        return c.clone();
    }
    let content = SUBAGENT_MD.to_string();
    *cache = Some(content.clone());
    content
}

/// Force-reload the skill cache (useful for tests).
pub fn reset_skill_cache_for_test() {
    *CACHED_SKILL_MD.lock().unwrap() = None;
    *CACHED_SUBAGENT_MD.lock().unwrap() = None;
}

/// Input to `build_prompt` (worktree context).
#[derive(Clone)]
pub struct BuildPromptInput {
    pub project: ProjectRecord,
    pub worktree: WorktreeRecord,
    pub mode_context: Option<String>,
    pub user_prompt: Option<String>,
    pub rich_chat: bool,
}

/// Input to `build_direct_prompt` (direct context, no worktree).
#[derive(Clone)]
pub struct BuildDirectPromptInput {
    pub project: ProjectRecord,
    pub mode_context: Option<String>,
    pub user_prompt: Option<String>,
    pub rich_chat: bool,
}

/// Output of either builder.
#[derive(Clone, Debug)]
pub struct BuiltPrompt {
    pub system_prompt: String,
    pub task_prompt: Option<String>,
}

/// Build the layered prompt for a worktree agent spawn.
pub fn build_prompt(input: &BuildPromptInput) -> BuiltPrompt {
    let l1 = if input.rich_chat {
        format!("{}\n{}", load_skill_md(), load_subagent_md())
    } else {
        load_skill_md()
    };

    let wt_path = format!(
        "{}/projects/{}/worktrees/{}",
        crate::home::home_dir().display(),
        input.project.id,
        input.worktree.id
    );
    let mut l2_lines: Vec<String> = vec![
        String::new(),
        "## Context".into(),
        String::new(),
        format!("**Your working directory (worktree):** {wt_path}"),
        "> This is where you must read and write all files. Do NOT work in the project base directory.".into(),
        String::new(),
        format!("**Project:** {}", input.project.id),
        format!("**Project base directory:** {} — for reference only; do not edit files here", input.project.absolute_path),
        format!("**Default branch:** {}", input.project.default_branch.as_deref().unwrap_or("main")),
        format!("**Worktree:** {}", input.worktree.id),
        format!("**Branch:** {}", input.worktree.branch),
        format!("**Base branch:** {} @ {}", input.worktree.base_branch, input.worktree.base_sha),
    ];

    if !input.worktree.sessions.is_empty() {
        l2_lines.push(String::new());
        l2_lines.push("**Sibling sessions in this worktree:**".into());
        for s in &input.worktree.sessions {
            let ty = session_type_str(s.r#type);
            let state = lifecycle_state_str(s.lifecycle.state);
            l2_lines.push(format!(
                "- {} ({}, type={}, state={})",
                s.id,
                if s.is_main { "main" } else { ty },
                ty,
                state
            ));
        }
    }

    if let Some(mode_context) = &input.mode_context {
        l2_lines.push(String::new());
        l2_lines.push("## Mode Instructions".into());
        l2_lines.push(String::new());
        l2_lines.push(mode_context.clone());
    }

    let l2 = l2_lines.join("\n");
    let l3 = read_project_rules(&input.project.absolute_path);

    let mut system_prompt = l1;
    system_prompt.push('\n');
    system_prompt.push_str(&l2);
    if let Some(rules) = l3 {
        system_prompt.push('\n');
        system_prompt.push_str(&rules);
    }

    BuiltPrompt {
        system_prompt,
        task_prompt: input.user_prompt.clone().filter(|s| !s.is_empty()),
    }
}

/// Build the layered prompt for a direct (no-worktree) agent spawn.
pub fn build_direct_prompt(input: &BuildDirectPromptInput) -> BuiltPrompt {
    let l1 = if input.rich_chat {
        format!("{}\n{}", load_skill_md(), load_subagent_md())
    } else {
        load_skill_md()
    };

    let mut l2_lines: Vec<String> = vec![
        String::new(),
        "## Context".into(),
        String::new(),
        format!(
            "**Your working directory:** {}",
            input.project.absolute_path
        ),
        "> This is a direct session running in the project directory (no worktree isolation)."
            .into(),
        String::new(),
        format!("**Project:** {}", input.project.id),
    ];

    if input.project.is_git && input.project.default_branch.is_some() {
        l2_lines.push(format!(
            "**Default branch:** {}",
            input.project.default_branch.as_deref().unwrap()
        ));
        l2_lines.push(String::new());
        l2_lines.push("> Note: You are editing files directly in the project directory.".into());
        l2_lines
            .push("> Changes will affect the current working tree (no branch isolation).".into());
    } else {
        l2_lines.push(String::new());
        l2_lines.push("> This is a non-git project. No version control is active.".into());
    }

    if let Some(mode_context) = &input.mode_context {
        l2_lines.push(String::new());
        l2_lines.push("## Mode Instructions".into());
        l2_lines.push(String::new());
        l2_lines.push(mode_context.clone());
    }

    let l2 = l2_lines.join("\n");
    let l3 = read_project_rules(&input.project.absolute_path);

    let mut system_prompt = l1;
    system_prompt.push('\n');
    system_prompt.push_str(&l2);
    if let Some(rules) = l3 {
        system_prompt.push('\n');
        system_prompt.push_str(&rules);
    }

    BuiltPrompt {
        system_prompt,
        task_prompt: input.user_prompt.clone().filter(|s| !s.is_empty()),
    }
}

fn read_project_rules(project_path: &str) -> Option<String> {
    let candidates = [
        std::path::Path::new(project_path).join("AGENTS.md"),
        std::path::Path::new(project_path)
            .join(".vibe-station")
            .join("rules.md"),
    ];
    for candidate in &candidates {
        if let Ok(content) = std::fs::read_to_string(candidate) {
            return Some(content);
        }
    }
    None
}

fn session_type_str(t: SessionType) -> &'static str {
    match t {
        SessionType::Agent => "agent",
        SessionType::Terminal => "terminal",
    }
}

fn lifecycle_state_str(s: LifecycleState) -> &'static str {
    match s {
        LifecycleState::NotStarted => "not_started",
        LifecycleState::Working => "working",
        LifecycleState::Idle => "idle",
        LifecycleState::WaitingForHuman => "waiting_for_human",
        LifecycleState::Done => "done",
        LifecycleState::Exited => "exited",
        LifecycleState::Drafting => "drafting",
    }
}
