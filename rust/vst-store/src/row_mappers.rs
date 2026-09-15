//! Row <-> record mappers for `vibe-station.db` — ports `daemon/src/state/sqliteRowMappers.ts`.
//!
//! `row_to_bool` is the single coercion point for INTEGER "boolean" columns
//! (`0`/`1`, never `true`/`false`).

use vst_types::{
    Channel, DraftConfig, LifecycleState, PrState, ProjectRecord, SessionLifecycle,
    SessionNameSource, SessionRecord, SessionType, TranscriptKind, TranscriptRef, WorktreeRecord,
};

/// Coerce an INTEGER "boolean" column value (`0`/`1`) to `bool`.
#[must_use]
pub fn row_to_bool(v: i64) -> bool {
    v == 1
}

/// Coerce a `bool` to the INTEGER `0`/`1` column value.
#[must_use]
pub fn bool_to_row(v: bool) -> i64 {
    if v {
        1
    } else {
        0
    }
}

// --- enum string conversions (defensive: unknown values never panic) ---

fn parse_type(s: &str) -> SessionType {
    match s {
        "terminal" => SessionType::Terminal,
        _ => SessionType::Agent,
    }
}
fn type_str(t: SessionType) -> &'static str {
    match t {
        SessionType::Agent => "agent",
        SessionType::Terminal => "terminal",
    }
}

fn parse_channel(s: &str) -> Option<Channel> {
    match s {
        "tmux" => Some(Channel::Tmux),
        "pty" => Some(Channel::Pty),
        "json" => Some(Channel::Json),
        _ => None,
    }
}
fn channel_str(c: Channel) -> &'static str {
    match c {
        Channel::Tmux => "tmux",
        Channel::Pty => "pty",
        Channel::Json => "json",
    }
}

fn parse_name_source(s: &str) -> Option<SessionNameSource> {
    match s {
        "auto" => Some(SessionNameSource::Auto),
        "user" => Some(SessionNameSource::User),
        _ => None,
    }
}
fn name_source_str(s: SessionNameSource) -> &'static str {
    match s {
        SessionNameSource::Auto => "auto",
        SessionNameSource::User => "user",
    }
}

fn parse_lifecycle_state(s: &str) -> LifecycleState {
    match s {
        "not_started" => LifecycleState::NotStarted,
        "working" => LifecycleState::Working,
        "idle" => LifecycleState::Idle,
        "waiting_for_human" => LifecycleState::WaitingForHuman,
        "done" => LifecycleState::Done,
        "exited" => LifecycleState::Exited,
        "drafting" => LifecycleState::Drafting,
        // Legacy "needs_review" maps to idle (handled by the caller for the PR
        // back-compat); defensive default here.
        _ => LifecycleState::Idle,
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

fn parse_transcript_kind(s: &str) -> Option<TranscriptKind> {
    match s {
        "vst-json" => Some(TranscriptKind::VstJson),
        "claude-jsonl" => Some(TranscriptKind::ClaudeJsonl),
        "opencode-session" => Some(TranscriptKind::OpencodeSession),
        "none" => Some(TranscriptKind::None),
        _ => None,
    }
}
fn transcript_kind_str(k: TranscriptKind) -> &'static str {
    match k {
        TranscriptKind::VstJson => "vst-json",
        TranscriptKind::ClaudeJsonl => "claude-jsonl",
        TranscriptKind::OpencodeSession => "opencode-session",
        TranscriptKind::None => "none",
    }
}

fn parse_pr_state(s: &str) -> Option<PrState> {
    match s {
        "none" => Some(PrState::None),
        "draft" => Some(PrState::Draft),
        "open" => Some(PrState::Open),
        "merged" => Some(PrState::Merged),
        "closed" => Some(PrState::Closed),
        _ => None,
    }
}
fn pr_state_str(s: PrState) -> &'static str {
    match s {
        PrState::None => "none",
        PrState::Draft => "draft",
        PrState::Open => "open",
        PrState::Merged => "merged",
        PrState::Closed => "closed",
    }
}

/// The raw `sessions` row shape as stored in the DB.
#[derive(Clone, Debug, Default)]
pub struct SessionRow {
    pub id: String,
    pub worktree_id: Option<String>,
    pub project_id: String,
    pub is_main: i64,
    pub sort_order: f64,
    pub r#type: String,
    pub mode_id: Option<String>,
    pub name: Option<String>,
    pub name_source: Option<String>,
    pub tmux_name: String,
    pub use_tmux: i64,
    pub channel: Option<String>,
    pub state: String,
    pub reason: Option<String>,
    pub last_transition_at: String,
    pub transcript_kind: Option<String>,
    pub transcript_path: Option<String>,
    pub agent_chat_id: Option<String>,
    pub acp_session_id: Option<String>,
    pub model_override: Option<String>,
    pub pinned_at: Option<String>,
    pub initial_prompt: Option<String>,
    pub archived_at: Option<String>,
    pub handoff_summary: Option<String>,
    pub draft_prompt: Option<String>,
    pub draft_config: Option<String>,
    pub spawned_from: Option<String>,
    pub superseded_by: Option<String>,
    pub pr_state: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_url: Option<String>,
    pub pr_checked_at: Option<String>,
    pub pr_branch: Option<String>,
}

/// Row -> `SessionRecord`, applying the `needs_review` back-compat (R10): a
/// persisted `needs_review` state maps to an `idle` lifecycle + an open PR.
pub fn row_to_session(row: &SessionRow) -> SessionRecord {
    let transcript_ref = row.transcript_kind.as_deref().and_then(|k| {
        parse_transcript_kind(k).map(|kind| TranscriptRef {
            kind,
            path: row.transcript_path.clone(),
        })
    });

    let pr = row.pr_state.as_deref().and_then(|s| {
        parse_pr_state(s).map(|state| vst_types::PrStatus {
            state,
            number: row.pr_number,
            url: row.pr_url.clone(),
            checked_at: row.pr_checked_at.clone().unwrap_or_default(),
            error: None,
            pr_branch: row.pr_branch.clone(),
        })
    });

    let is_legacy_needs_review = row.state == "needs_review";
    let lifecycle_state = if is_legacy_needs_review {
        LifecycleState::Idle
    } else {
        parse_lifecycle_state(&row.state)
    };
    // One-way back-compat: `needs_review` with no persisted PR becomes an open PR.
    let legacy_pr = (is_legacy_needs_review && pr.is_none()).then(|| vst_types::PrStatus {
        state: PrState::Open,
        number: None,
        url: None,
        checked_at: String::new(),
        error: None,
        pr_branch: None,
    });

    SessionRecord {
        id: row.id.clone(),
        worktree_id: row.worktree_id.clone(),
        project_id: row.project_id.clone(),
        is_main: row_to_bool(row.is_main),
        sort_order: row.sort_order,
        r#type: parse_type(&row.r#type),
        mode_id: row.mode_id.clone(),
        name: row.name.clone(),
        name_source: row.name_source.as_deref().and_then(parse_name_source),
        tmux_name: row.tmux_name.clone(),
        use_tmux: row_to_bool(row.use_tmux),
        channel: row.channel.as_deref().and_then(parse_channel),
        lifecycle: SessionLifecycle {
            state: lifecycle_state,
            reason: row.reason.clone(),
            last_transition_at: row.last_transition_at.clone(),
        },
        transcript_ref,
        agent_chat_id: row.agent_chat_id.clone(),
        acp_session_id: row.acp_session_id.clone(),
        model_override: row.model_override.clone(),
        pinned_at: row.pinned_at.clone(),
        initial_prompt: row.initial_prompt.clone(),
        archived_at: row.archived_at.clone(),
        handoff_summary: row.handoff_summary.clone(),
        draft_prompt: row.draft_prompt.clone(),
        draft_config: row
            .draft_config
            .as_deref()
            .and_then(|s| serde_json::from_str::<DraftConfig>(s).ok()),
        parent_session_id: row.spawned_from.clone(),
        superseded_by: row.superseded_by.clone(),
        pr: pr.or(legacy_pr),
    }
}

/// `SessionRecord` -> raw row. `use_tmux` is a concrete `bool` in the Rust
/// record (no `undefined`), so no `resolveUseTmux` coercion is needed.
pub fn session_to_row(
    session: &SessionRecord,
    project_id: &str,
    worktree_id: Option<&str>,
) -> SessionRow {
    SessionRow {
        id: session.id.clone(),
        worktree_id: worktree_id.map(str::to_string),
        project_id: project_id.to_string(),
        is_main: bool_to_row(session.is_main),
        sort_order: session.sort_order,
        r#type: type_str(session.r#type).to_string(),
        mode_id: session.mode_id.clone(),
        name: session.name.clone(),
        name_source: session.name_source.map(name_source_str).map(str::to_string),
        tmux_name: session.tmux_name.clone(),
        use_tmux: bool_to_row(session.use_tmux),
        channel: session.channel.map(channel_str).map(str::to_string),
        state: lifecycle_state_str(session.lifecycle.state).to_string(),
        reason: session.lifecycle.reason.clone(),
        last_transition_at: session.lifecycle.last_transition_at.clone(),
        transcript_kind: session
            .transcript_ref
            .as_ref()
            .map(|t| transcript_kind_str(t.kind).to_string()),
        transcript_path: session.transcript_ref.as_ref().and_then(|t| t.path.clone()),
        agent_chat_id: session.agent_chat_id.clone(),
        acp_session_id: session.acp_session_id.clone(),
        model_override: session.model_override.clone(),
        pinned_at: session.pinned_at.clone(),
        initial_prompt: session.initial_prompt.clone(),
        archived_at: session.archived_at.clone(),
        handoff_summary: session.handoff_summary.clone(),
        draft_prompt: session.draft_prompt.clone(),
        draft_config: session
            .draft_config
            .as_ref()
            .map(|c| serde_json::to_string(c).expect("draft config serializable")),
        spawned_from: session.parent_session_id.clone(),
        superseded_by: session.superseded_by.clone(),
        pr_state: session
            .pr
            .as_ref()
            .map(|p| pr_state_str(p.state).to_string()),
        pr_number: session.pr.as_ref().and_then(|p| p.number),
        pr_url: session.pr.as_ref().and_then(|p| p.url.clone()),
        pr_checked_at: session.pr.as_ref().map(|p| p.checked_at.clone()),
        pr_branch: session.pr.as_ref().and_then(|p| p.pr_branch.clone()),
    }
}

/// The raw `worktrees` row shape.
#[derive(Clone, Debug, Default)]
pub struct WorktreeRow {
    pub id: String,
    pub project_id: String,
    pub name: Option<String>,
    pub branch: String,
    pub base_branch: Option<String>,
    pub base_sha: Option<String>,
    pub created_at: String,
    pub pinned_at: Option<String>,
    pub hidden_at: Option<String>,
    pub sort_order: f64,
    pub terminal_seq: i64,
    pub agent_seq: i64,
    pub branch_is_placeholder: i64,
}

pub fn row_to_worktree(row: &WorktreeRow, sessions: Vec<SessionRecord>) -> WorktreeRecord {
    WorktreeRecord {
        id: row.id.clone(),
        name: row.name.clone(),
        branch: row.branch.clone(),
        // The DB column stores only 0/1 and cannot distinguish "absent" from
        // an explicit `false` (both map to 0), so a read always yields a
        // concrete boolean — `Some(false)` round-trips stably.
        branch_is_placeholder: Some(row_to_bool(row.branch_is_placeholder)),
        base_branch: row.base_branch.clone().unwrap_or_default(),
        base_sha: row.base_sha.clone().unwrap_or_default(),
        created_at: row.created_at.clone(),
        pinned_at: row.pinned_at.clone(),
        hidden_at: row.hidden_at.clone(),
        sort_order: row.sort_order,
        terminal_seq: Some(row.terminal_seq),
        agent_seq: Some(row.agent_seq),
        sessions,
    }
}

pub fn worktree_to_row(w: &WorktreeRecord, project_id: &str) -> WorktreeRow {
    WorktreeRow {
        id: w.id.clone(),
        project_id: project_id.to_string(),
        name: w.name.clone(),
        branch: w.branch.clone(),
        base_branch: Some(w.base_branch.clone()),
        base_sha: Some(w.base_sha.clone()),
        created_at: w.created_at.clone(),
        pinned_at: w.pinned_at.clone(),
        hidden_at: w.hidden_at.clone(),
        sort_order: w.sort_order,
        terminal_seq: w.terminal_seq.unwrap_or(0),
        agent_seq: w.agent_seq.unwrap_or(0),
        branch_is_placeholder: bool_to_row(w.branch_is_placeholder.unwrap_or(false)),
    }
}

/// The raw `projects` row shape.
#[derive(Clone, Debug, Default)]
pub struct ProjectRow {
    pub id: String,
    pub absolute_path: String,
    pub prefix: String,
    pub is_git: i64,
    pub default_branch: Option<String>,
    pub created_at: String,
    pub hidden: i64,
    pub direct_session_seq: i64,
    pub next_worktree_num: i64,
}

pub fn row_to_project(
    row: &ProjectRow,
    worktrees: Vec<WorktreeRecord>,
    direct_sessions: Vec<SessionRecord>,
) -> ProjectRecord {
    ProjectRecord {
        id: row.id.clone(),
        absolute_path: row.absolute_path.clone(),
        prefix: row.prefix.clone(),
        is_git: row_to_bool(row.is_git),
        default_branch: row.default_branch.clone(),
        created_at: row.created_at.clone(),
        hidden: row_to_bool(row.hidden).then_some(true),
        direct_sessions,
        direct_session_seq: Some(row.direct_session_seq),
        worktrees,
        next_worktree_num: Some(row.next_worktree_num),
    }
}

pub fn project_to_row(p: &ProjectRecord) -> ProjectRow {
    ProjectRow {
        id: p.id.clone(),
        absolute_path: p.absolute_path.clone(),
        prefix: p.prefix.clone(),
        is_git: bool_to_row(p.is_git),
        default_branch: p.default_branch.clone(),
        created_at: p.created_at.clone(),
        hidden: bool_to_row(p.hidden.unwrap_or(false)),
        direct_session_seq: p.direct_session_seq.unwrap_or(0),
        next_worktree_num: p.next_worktree_num.unwrap_or(1),
    }
}
