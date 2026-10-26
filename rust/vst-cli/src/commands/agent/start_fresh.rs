//! `vst agent start-fresh` — archive the session and spawn a replacement in
//! the SAME mode, optionally carrying a summary or a transcript.

use vst_types::domain::CarryOver;

use super::carry::{
    check_self_target, parse_carry_args, resolve_summary_text, run_reset, CarryOptions,
};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionStartFreshOptions {
    pub carry: CarryOptions,
}

pub fn parse_session_start_fresh_options(
    args: &[String],
) -> Result<SessionStartFreshOptions, String> {
    let (mut carry, mode) = parse_carry_args(args, false)?;
    if mode.is_some() {
        return Err("Unknown option: --mode (only `vst agent switch` takes a mode)".to_string());
    }
    let effective = carry.effective_carry(CarryOver::Nothing);
    if carry.summary_file.is_some() && effective != CarryOver::Summary {
        return Err("--summary-file requires --carry=summary".to_string());
    }
    carry.carry = Some(effective);
    Ok(SessionStartFreshOptions { carry })
}

/// `vst agent clear <id>` — exactly `start-fresh --carry=none` (acts like
/// `/clear`: empty memory, chat cleared, old chat kept under `previous`).
pub fn parse_session_clear_options(args: &[String]) -> Result<SessionStartFreshOptions, String> {
    if let Some(bad) = args
        .iter()
        .find(|a| a.starts_with("--carry") || a.starts_with("--summary-file"))
    {
        return Err(format!(
            "`vst agent clear` carries nothing; {bad} is not allowed (use `vst agent start-fresh`)"
        ));
    }
    let mut with_carry = args.to_vec();
    with_carry.push("--carry=none".to_string());
    parse_session_start_fresh_options(&with_carry)
}

pub async fn run_session_start_fresh(opts: SessionStartFreshOptions) -> Result<(), (String, i32)> {
    let carry = opts.carry.carry.unwrap_or(CarryOver::Nothing);
    check_self_target(&opts.carry, carry)?;
    let handoff_text = resolve_summary_text(&opts.carry).map_err(|e| (e, 1))?;

    run_reset(&opts.carry, carry, None, handoff_text, "Started fresh").await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn clear_is_start_fresh_with_nothing() {
        let o = parse_session_clear_options(&v(&["s-1"])).unwrap();
        assert_eq!(o.carry.carry, Some(CarryOver::Nothing));
    }

    #[test]
    fn clear_rejects_carry_flags() {
        assert!(parse_session_clear_options(&v(&["s-1", "--carry=summary"])).is_err());
        assert!(parse_session_clear_options(&v(&["s-1", "--summary-file=x"])).is_err());
    }
}
