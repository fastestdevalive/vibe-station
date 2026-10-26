//! Phase 2 harness-limits probe tests: fixture-driven parser tests for the
//! claude and codex probes, the default `unsupported` for every other plugin,
//! and ignored live probe tests (2.T5) for eyeballing Spike results.

use std::path::PathBuf;

use vst_agents::registry::resolve_plugin;
use vst_agents::{create_agy_plugin, create_claude_plugin, create_codex_plugin, AgentPlugin};
use vst_types::{CliId, LimitStatus, LimitsResult};

fn fixture(name: &str) -> serde_json::Value {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "tests",
        "fixtures",
        "limits",
        name,
    ]
    .iter()
    .collect();
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("missing fixture {name}: {e}"));
    serde_json::from_str(&raw).unwrap()
}

fn window<'a>(res: &'a LimitsResult, id: &str) -> &'a vst_types::LimitWindow {
    res.windows.iter().find(|w| w.window_id == id).unwrap()
}

mod claude_parser {
    use super::*;

    const AS_OF: &str = "2026-10-11T00:41:50.000Z";

    #[test]
    fn ok_fixture_two_windows() {
        let msg = fixture("claude-usage-ok.json");
        let res = vst_agents::claude_limits::interpret_claude_response(&msg, AS_OF);
        assert_eq!(res.harness, "claude");
        assert_eq!(res.status, LimitStatus::Ok);
        assert_eq!(res.windows.len(), 2);

        let fh = window(&res, "five_hour");
        assert_eq!(fh.cadence_minutes, Some(300));
        assert_eq!(fh.used_pct, Some(21.0));
        assert_eq!(fh.status, LimitStatus::Ok);
        assert!(fh.resets_at.as_deref().unwrap().ends_with('Z'));
        assert!(chrono::DateTime::parse_from_rfc3339(fh.resets_at.as_deref().unwrap()).is_ok());

        let sd = window(&res, "seven_day");
        assert_eq!(sd.cadence_minutes, Some(10080));
        assert_eq!(sd.used_pct, Some(21.5));
        assert_eq!(sd.status, LimitStatus::Ok);
    }

    #[test]
    fn signed_out_fixture_no_plan_limits_placeholders() {
        let msg = fixture("claude-usage-signed-out.json");
        let res = vst_agents::claude_limits::interpret_claude_response(&msg, AS_OF);
        assert_eq!(res.status, LimitStatus::NoPlanLimits);
        assert_eq!(res.windows.len(), 2);
        assert!(res.windows.iter().all(|w| w.used_pct.is_none()));
        assert!(res
            .windows
            .iter()
            .all(|w| w.status == LimitStatus::NoPlanLimits));
    }

    #[test]
    fn partial_fixture_ok_with_no_data_seven_day() {
        let msg = fixture("claude-usage-partial.json");
        let res = vst_agents::claude_limits::interpret_claude_response(&msg, AS_OF);
        assert_eq!(res.status, LimitStatus::Ok);
        assert_eq!(window(&res, "five_hour").used_pct, Some(7.0));
        assert_eq!(window(&res, "seven_day").status, LimitStatus::NoData);
        assert_eq!(window(&res, "seven_day").used_pct, None);
    }

    #[test]
    fn error_fixture_error_with_message() {
        let msg = fixture("claude-usage-error.json");
        let res = vst_agents::claude_limits::interpret_claude_response(&msg, AS_OF);
        assert_eq!(res.status, LimitStatus::Error);
        assert_eq!(res.message.as_deref(), Some("boom"));
        assert_eq!(res.windows.len(), 2);
    }

    #[test]
    fn unknown_extra_keys_ignored() {
        let msg = fixture("claude-usage-ok.json");
        let res = vst_agents::claude_limits::interpret_claude_response(&msg, AS_OF);
        // iguana_necktie and limits[] must not be turned into windows.
        assert_eq!(res.windows.len(), 2);
        assert_eq!(window(&res, "five_hour").used_pct, Some(21.0));
    }
}

mod codex_parser {
    use super::*;

    const AS_OF: &str = "2026-10-11T00:41:51.000Z";

    #[test]
    fn free_fixture_one_primary_window() {
        let msg = fixture("codex-rate-limits-free.json");
        let res = vst_agents::codex_limits::interpret_codex_rate_limits(&msg, AS_OF);
        assert_eq!(res.harness, "codex");
        assert_eq!(res.status, LimitStatus::Ok);
        assert_eq!(res.windows.len(), 1);

        let primary = window(&res, "primary");
        assert_eq!(primary.cadence_minutes, Some(43200));
        assert_eq!(primary.used_pct, Some(4.0));
        assert_eq!(primary.status, LimitStatus::Ok);
        // resetsAt 1793561922 secs -> ISO with millis.
        assert_eq!(
            primary.resets_at.as_deref(),
            Some("2026-11-01T19:38:42.000Z")
        );
    }

    #[test]
    fn pro_fixture_two_windows() {
        let msg = fixture("codex-rate-limits-pro.json");
        let res = vst_agents::codex_limits::interpret_codex_rate_limits(&msg, AS_OF);
        assert_eq!(res.status, LimitStatus::Ok);
        assert_eq!(res.windows.len(), 2);
        assert_eq!(window(&res, "primary").cadence_minutes, Some(300));
        assert_eq!(window(&res, "primary").used_pct, Some(37.0));
        assert_eq!(window(&res, "secondary").cadence_minutes, Some(10080));
        assert_eq!(window(&res, "secondary").used_pct, Some(12.0));
    }

    #[test]
    fn auth_error_signed_out() {
        let msg = fixture("codex-rate-limits-auth-error.json");
        let res = vst_agents::codex_limits::interpret_codex_rate_limits(&msg, AS_OF);
        assert_eq!(res.status, LimitStatus::SignedOut);
        assert_eq!(
            res.message.as_deref(),
            Some("Not signed in to Codex (run `codex login`)")
        );
    }

    #[test]
    fn used_percent_one_means_one_no_scaling() {
        let mut msg = fixture("codex-rate-limits-free.json");
        msg["result"]["rateLimits"]["primary"]["usedPercent"] = serde_json::json!(1);
        let res = vst_agents::codex_limits::interpret_codex_rate_limits(&msg, AS_OF);
        assert_eq!(window(&res, "primary").used_pct, Some(1.0));
    }
}

mod agy_parser {
    use super::*;

    const AS_OF: &str = "2026-10-11T00:41:52.000Z";

    #[test]
    fn ok_fixture_five_windows() {
        let msg = fixture("agy-usage-ok.json");
        let res = vst_agents::agy_limits::interpret_agy_usage(&msg, AS_OF);
        assert_eq!(res.harness, "agy");
        assert_eq!(res.status, LimitStatus::Ok);
        assert_eq!(res.windows.len(), 5);

        let weekly = window(&res, "gemini_weekly");
        assert_eq!(weekly.cadence_minutes, Some(10080));
        assert!((weekly.used_pct.unwrap() - 0.8395).abs() < 0.01);
        assert_eq!(weekly.status, LimitStatus::Ok);

        let three_p = window(&res, "3p_5h");
        assert_eq!(three_p.cadence_minutes, Some(300));
        assert_eq!(three_p.used_pct, Some(0.0));
        assert_eq!(three_p.status, LimitStatus::Ok);
        assert!(three_p.resets_at.as_deref().unwrap().ends_with('Z'));
        assert!(
            chrono::DateTime::parse_from_rfc3339(three_p.resets_at.as_deref().unwrap()).is_ok()
        );
    }

    #[test]
    fn signed_out_fixture() {
        let msg = fixture("agy-usage-signed-out.json");
        let res = vst_agents::agy_limits::interpret_agy_usage(&msg, AS_OF);
        assert_eq!(res.status, LimitStatus::SignedOut);
        assert_eq!(
            res.message.as_deref(),
            Some("Not signed in to agy (run `agy`)")
        );
        assert_eq!(res.windows.len(), 2);
        assert_eq!(window(&res, "gemini_5h").cadence_minutes, Some(300));
        assert_eq!(window(&res, "gemini_weekly").cadence_minutes, Some(10080));
        assert!(res.windows.iter().all(|w| w.used_pct.is_none()));
    }

    #[test]
    fn non_success_without_auth_text_is_error() {
        let mut msg = fixture("agy-usage-signed-out.json");
        msg["status"] = serde_json::json!("ERROR");
        msg["response"] = serde_json::json!("usage probe exploded");
        let res = vst_agents::agy_limits::interpret_agy_usage(&msg, AS_OF);
        assert_eq!(res.status, LimitStatus::Error);
        assert_eq!(res.message.as_deref(), Some("usage probe exploded"));
        assert!(res.windows.is_empty());
    }

    #[test]
    fn empty_groups_is_no_data() {
        let mut msg = fixture("agy-usage-ok.json");
        msg["command"]["data"]["groups"] = serde_json::json!([]);
        let res = vst_agents::agy_limits::interpret_agy_usage(&msg, AS_OF);
        assert_eq!(res.status, LimitStatus::NoData);
        assert_eq!(
            res.message.as_deref(),
            Some("agy returned no usage windows")
        );
        assert_eq!(res.windows.len(), 2);
        assert!(res.windows.iter().all(|w| w.used_pct.is_none()));
    }

    #[test]
    fn bucket_without_fraction_skipped() {
        let mut msg = fixture("agy-usage-ok.json");
        msg["command"]["data"]["groups"][0]["buckets"][0]["remaining_fraction"] =
            serde_json::Value::Null;
        let res = vst_agents::agy_limits::interpret_agy_usage(&msg, AS_OF);
        assert_eq!(res.status, LimitStatus::Ok);
        assert_eq!(res.windows.len(), 4);
        assert!(res.windows.iter().all(|w| w.window_id != "gemini_weekly"));
    }

    #[test]
    fn duplicate_and_empty_ids_skipped_and_cadence_units_parsed() {
        let msg = serde_json::json!({
            "status": "SUCCESS",
            "command": {"data": {"groups": [{"buckets": [
                {"id": "a-b", "window": "90m", "remaining_fraction": 0.5, "reset_time": "2026-10-18T11:27:20Z"},
                {"id": "A_B", "window": "2d", "remaining_fraction": 0.1},
                {"id": "--", "window": "5h", "remaining_fraction": 0.1}
            ]}]}}
        });
        let res = vst_agents::agy_limits::interpret_agy_usage(&msg, AS_OF);
        assert_eq!(res.windows.len(), 1);
        let w = window(&res, "a_b");
        assert_eq!(w.cadence_minutes, Some(90));
        assert_eq!(w.used_pct, Some(50.0));
    }

    #[test]
    fn network_login_text_is_error_not_signed_out() {
        let msg =
            serde_json::json!({"status": "ERROR", "response": "failed to reach login server"});
        let res = vst_agents::agy_limits::interpret_agy_usage(&msg, AS_OF);
        assert_eq!(res.status, LimitStatus::Error);
    }

    #[test]
    fn fraction_out_of_range_clamped() {
        let mut msg = fixture("agy-usage-ok.json");
        msg["command"]["data"]["groups"][0]["buckets"][0]["remaining_fraction"] =
            serde_json::json!(1.5);
        let res = vst_agents::agy_limits::interpret_agy_usage(&msg, AS_OF);
        assert_eq!(window(&res, "gemini_weekly").used_pct, Some(0.0));

        let mut msg = fixture("agy-usage-ok.json");
        msg["command"]["data"]["groups"][0]["buckets"][0]["remaining_fraction"] =
            serde_json::json!(-0.2);
        let res = vst_agents::agy_limits::interpret_agy_usage(&msg, AS_OF);
        assert_eq!(window(&res, "gemini_weekly").used_pct, Some(100.0));
    }
}

#[tokio::test]
async fn default_plugins_report_unsupported() {
    for cli in [CliId::Cursor, CliId::Opencode, CliId::Pi, CliId::Omp] {
        let plugin = resolve_plugin(cli);
        let res = plugin.get_limits().await;
        assert_eq!(
            res.status,
            LimitStatus::Unsupported,
            "{cli:?} must default to Unsupported, got {res:?}"
        );
    }
}

// claude/codex/agy override get_limits; sanity-check the override resolves to
// the probe (not the default). These are async but never reach the network when
// the binary is absent from PATH — they return NotInstalled instead.
#[tokio::test]
async fn limit_plugins_override_get_limits() {
    let claude = create_claude_plugin().get_limits().await;
    assert_ne!(claude.status, LimitStatus::Unsupported);
    let codex = create_codex_plugin().get_limits().await;
    assert_ne!(codex.status, LimitStatus::Unsupported);
    let agy = create_agy_plugin().get_limits().await;
    assert_ne!(agy.status, LimitStatus::Unsupported);
}

// 2.T5 — live probes (manual): `cargo test -p vst-agents --test limits_probes
// -- --ignored live_claude live_codex --nocapture`.
#[tokio::test]
#[ignore]
async fn live_claude() {
    let res = vst_agents::claude_limits::probe_claude_limits().await;
    println!("claude: {}", serde_json::to_string_pretty(&res).unwrap());
}

#[tokio::test]
#[ignore]
async fn live_codex() {
    let res = vst_agents::codex_limits::probe_codex_limits().await;
    println!("codex: {}", serde_json::to_string_pretty(&res).unwrap());
}

#[tokio::test]
#[ignore]
async fn live_agy() {
    let res = vst_agents::agy_limits::probe_agy_limits().await;
    println!("agy: {}", serde_json::to_string_pretty(&res).unwrap());
}
