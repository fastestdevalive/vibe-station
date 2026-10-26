//! `vst agent switch` — archive the session and spawn a replacement on another
//! mode (provider and/or model), carrying a summary or a transcript.

use vst_types::domain::CarryOver;
use vst_types::rest::sessions::SessionOrDraft;
use vst_types::rest::shared::Mode;

use crate::client::{daemon_get, DaemonResult};

use super::carry::{
    check_self_target, encode_id, parse_carry_args, resolve_summary_text, CarryOptions,
};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionSwitchOptions {
    pub carry: CarryOptions,
    /// Mode id or name (resolved by the daemon).
    pub mode: String,
}

pub fn parse_session_switch_options(args: &[String]) -> Result<SessionSwitchOptions, String> {
    let (mut carry, mode) = parse_carry_args(args, true)?;
    let mode = mode.ok_or_else(|| "--mode is required for `vst agent switch`".to_string())?;
    if mode.is_empty() {
        return Err("--mode requires a non-empty argument".to_string());
    }
    let effective = carry.effective_carry(CarryOver::Summary);
    if effective == CarryOver::Nothing {
        return Err(
            "--carry=none is not available for switch. Use --carry=summary or \
             --carry=transcript, or `vst agent create` for a clean agent on another mode."
                .to_string(),
        );
    }
    if carry.summary_file.is_some() && effective != CarryOver::Summary {
        return Err("--summary-file requires --carry=summary".to_string());
    }
    carry.carry = Some(effective);
    Ok(SessionSwitchOptions { carry, mode })
}

pub async fn run_session_switch(opts: SessionSwitchOptions) -> Result<(), (String, i32)> {
    let carry = opts.carry.carry.unwrap_or(CarryOver::Summary);
    check_self_target(&opts.carry, carry)?;
    let handoff_text = resolve_summary_text(&opts.carry).map_err(|e| (e, 1))?;

    crate::preflight::preflight().await;

    // Refuse a no-op switch BEFORE archiving anything: the daemon accepts a
    // same-mode `modeId` (it just records `breakKind: reset`), so without this
    // check `switch --mode=<current>` would silently start a fresh session
    // instead of telling the caller they picked the mode they are already on.
    let current = current_mode_id(&opts.carry.id).await?;
    let (target_id, target_name) = resolve_mode(&opts.mode)
        .await
        .unwrap_or_else(|| (opts.mode.clone(), opts.mode.clone()));
    if current.as_deref() == Some(target_id.as_str()) {
        return Err((
            format!("Already on mode {target_name}. Pick another mode."),
            1,
        ));
    }

    super::carry::post_reset(
        &opts.carry,
        carry,
        Some(opts.mode),
        handoff_text,
        "Switched",
    )
    .await
}

/// The session's current mode id. A 404 is fatal (the POST would 404 too);
/// any other failure is tolerated so a transient GET cannot block a switch.
async fn current_mode_id(session_id: &str) -> Result<Option<String>, (String, i32)> {
    let encoded = encode_id(session_id);
    match daemon_get::<SessionOrDraft>(&format!("/sessions/{encoded}")).await {
        Ok(DaemonResult::Ok { data, .. }) => Ok(match data {
            SessionOrDraft::Session(s) => s.mode_id,
            SessionOrDraft::GlobalDraft(g) => g.mode_id,
        }),
        Ok(DaemonResult::Err { status, error, .. }) => {
            if status == 404 {
                Err((error, 2))
            } else {
                Ok(None)
            }
        }
        Err(_) => Ok(None),
    }
}

/// Resolve a mode id-or-name to `(id, display name)`. `None` means the mode
/// list is unavailable (or the mode is unknown), in which case the daemon gets
/// the raw value and answers `mode_not_found` itself.
async fn resolve_mode(requested: &str) -> Option<(String, String)> {
    match daemon_get::<Vec<Mode>>("/modes").await {
        Ok(DaemonResult::Ok { data, .. }) => data
            .into_iter()
            .find(|m| m.id == requested || m.name == requested)
            .map(|m| (m.id, m.name)),
        _ => None,
    }
}
