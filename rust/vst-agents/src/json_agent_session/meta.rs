//! JsonAgentSession meta assembly — ports the no-live-session meta rebuild free
//! functions of `jsonAgent.ts` (`buildMetaFromTranscript`,
//! `buildMetaFromStoreMeta`, `assembleMeta`) plus the `hasRealUsage` gate.
//!
//! These are PURE functions (no live session state) used by the restart-durable
//! meta path (Decision 8, R2.6). The live `JsonAgentSession::get_meta` (which
//! uses `merge_with_skill_catalog` against live commands) lives in `mod.rs`.

use vst_store::transcript::TranscriptMeta;
use vst_types::{Channel, NormalizedEvent, NormalizedEventKind, SessionMeta, TurnState, UsageInfo};

use crate::skill_resolution::{cli_supports_skill_directive, merge_with_skill_catalog};

/// Options shared by the meta assembly functions.
#[derive(Clone, Debug)]
pub struct MetaOptions {
    pub session_id: String,
    pub cli: String,
    pub mode_id: Option<String>,
    pub mode_name: Option<String>,
    pub model_override: Option<String>,
    pub cwd: Option<String>,
}

/// True when a usage event reflects a real model call. A claude slash command
/// (/model, /cost, …) completes a turn without hitting the API and reports
/// `totalTokens: 0`; treating that as authoritative would clobber the running
/// token count with zero. Gate all `usage` writes through this.
pub fn has_real_usage(usage: &Option<UsageInfo>) -> bool {
    matches!(usage, Some(u) if u.total_tokens > 0)
}

/// Rebuild a `SessionMeta` from a full transcript (Decision 8 meta durability).
/// `modelOverride` wins over the transcript's observed model.
pub fn build_meta_from_transcript(opts: &MetaOptions, events: &[NormalizedEvent]) -> SessionMeta {
    let mut model = opts.model_override.clone();
    let mut usage: Option<UsageInfo> = None;
    let mut commands: Option<Vec<vst_types::Command>> = None;
    for ev in events {
        if let Some(m) = &ev.model {
            model = Some(m.clone());
        }
        if has_real_usage(&ev.usage) {
            usage = ev.usage.clone();
        }
        if ev.kind == NormalizedEventKind::CommandsUpdate {
            if let Some(c) = &ev.commands {
                commands = Some(c.clone());
            }
        }
    }
    assemble_meta(
        opts,
        &TranscriptMeta {
            model,
            usage,
            commands,
        },
    )
}

/// Assemble a `SessionMeta` from a bounded `TranscriptMeta` (last model + last
/// real usage), for the restart-durable no-live-session path (R2.6).
pub fn build_meta_from_store_meta(opts: &MetaOptions, meta: &TranscriptMeta) -> SessionMeta {
    assemble_meta(opts, meta)
}

/// Shared idle-meta assembly: apply the model override, then build the record.
pub fn assemble_meta(opts: &MetaOptions, found: &TranscriptMeta) -> SessionMeta {
    let model = opts.model_override.clone().or_else(|| found.model.clone());
    let commands = merge_with_skill_catalog(
        found.commands.as_deref(),
        cli_supports_skill_directive(&opts.cli),
    );
    SessionMeta {
        session_id: opts.session_id.clone(),
        channel: Channel::Json,
        mode_id: opts.mode_id.clone(),
        mode_name: opts.mode_name.clone(),
        cli: opts.cli.clone(),
        model,
        turn_state: TurnState::Idle,
        queue_depth: 0,
        queued_turn_ids: Vec::new(),
        editing_turn_ids: Vec::new(),
        usage: found.usage.clone(),
        cwd: opts.cwd.clone(),
        can_steer: None,
        commands,
        notice_slot: None,
    }
}
