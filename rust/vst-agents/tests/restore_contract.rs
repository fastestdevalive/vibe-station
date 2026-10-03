//! Cross-plugin restore contract (plan 2.4 / 2.T3).
//!
//! Every registered plugin MUST return `None` from `get_restore_command` for a
//! fresh session — a session with no stored chat id and no conversation of its
//! own — so `resume_spawn` falls back to a fresh launch that re-delivers the
//! initial prompt (Decision 5 / `AgentPlugin::get_restore_command` contract).
//!
//! Runs under an isolated home + cwd so no plugin sees a pre-existing native
//! conversation. Only `get_restore_command` is called here; `capture_chat_id`
//! is deliberately NOT (opencode/agy poll for up to 30s; pi's capture is
//! covered by the in-file unit test 2.T2).

mod common;

use vst_agents::home::with_home;
use vst_agents::plugin::RestoreArgs;
use vst_agents::{resolve_plugin, SUPPORTED_CLIS};

use common::{make_project, make_session};

#[tokio::test]
async fn every_plugin_returns_none_for_a_fresh_session() {
    let home = tempfile::tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    let cwd = tempfile::tempdir().unwrap();

    for cli in SUPPORTED_CLIS {
        let plugin = resolve_plugin(cli);
        let session = make_session("fresh-session");
        let result = plugin
            .get_restore_command(RestoreArgs {
                session: &session,
                project: &make_project("p1"),
                cwd: cwd.path().to_str().unwrap(),
                model: None,
            })
            .await;
        assert_eq!(
            result,
            None,
            "plugin {:?} returned a restore command for a fresh session",
            plugin.name()
        );
    }
}
