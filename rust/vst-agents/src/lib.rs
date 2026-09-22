#![forbid(unsafe_code)]

//! vst-agents — agent plugin trait + registry + per-plugin pure methods.
//!
//! Ports part-04a of the daemon-rust-port (see `arch-daemon-rust-port.md`):
//! `services/spawn.ts`'s `AgentPlugin` interface + supporting types (moved
//! here per Gotcha #11 — the trait lives with the plugins, not `vst-proc`),
//! `agent-plugins/registry.ts`, and each plugin's pure / table-driven methods
//! from `agent-plugins/{claude,cursor,opencode,agy}.ts`:
//!
//! - `spawn.ts` `AgentPlugin`       → [`plugin`] (`trait AgentPlugin`,
//!   [`plugin::LaunchConfig`], [`plugin::prompt_verification_needle`])
//! - `agent-plugins/registry.ts`    → [`registry`]
//! - `agent-plugins/claude.ts`      → [`claude`]
//! - `agent-plugins/cursor.ts`      → [`cursor`]
//! - `agent-plugins/opencode.ts`    → [`opencode`]
//! - `agent-plugins/agy.ts`         → [`agy`]
//!
//! ## Part-04a scope
//!
//! This part is deliberately **pure / table-driven — no live process**. Every
//! ported method is a deterministic function of its inputs (or, for the
//! filesystem methods `setup_workspace_hooks` / `provide_chat_id` /
//! `capture_chat_id` / `refresh_chat_id_on_toggle` / `capture_native_chat_id`,
//! a pure function of the workspace's files). It does NOT reach for
//! `vst-proc`'s `PtyHandle` or `acp_transport::AcpTransport` — those are
//! `04b`'s territory. `supports_acp()` here is only a boolean marker method,
//! not an actual ACP connection.
//!
//! ## The two session identities (ACP)
//!
//! `AGENTS.md` § Agent plugin is the authoritative method table. The
//! `identical` / `bridged` / `unavailable` strategy determines which optional
//! methods a plugin implements:
//! - `claude` / `opencode` — `identical`: implement neither
//!   `capture_native_chat_id` nor `supports_channel_resume` (≡ `true`).
//! - `agy` — `bridged`: implements `capture_native_chat_id`, not
//!   `supports_channel_resume`.
//! - `cursor` — `unavailable`: implements `capture_native_chat_id` (best-effort)
//!   AND `supports_json_to_terminal_resume() -> false`.
//!
//! ## Ported-from-scope helpers
//!
//! Two helper areas that belong to later parts are pulled forward here
//! because 04a's own tests exercise them through the plugin methods:
//! - `native-chat-id/{claude,cursor,agy}` (officially 04b) → [`native_chat_id`]
//! - `opencodeConfig.ts` + the `context.ts` path helpers (officially 04c)
//!   → [`opencode_config`] + [`paths`]
//!
//! They are implemented faithfully here so 04a's plugin methods behave
//! identically to the TS; the owning parts will reconcile/own them.

pub mod acp_connection;
pub mod acp_file_system;
pub mod acp_run_turn;
pub mod acp_terminal_manager;
pub mod acp_transport;
pub mod agy;
pub mod claude;
pub mod claude_import;
pub mod context;
pub mod cursor;
pub mod home;
pub mod json_agent_chat;
pub mod json_agent_registry;
pub mod json_agent_session;
pub mod json_agent_stream;
pub mod native_chat_id;
pub mod native_history_importer;
pub mod normalize;
pub mod opencode;
pub mod opencode_config;
pub mod opencode_import;
pub mod paths;
pub mod plugin;
pub mod prompt_builder;
pub mod registry;
pub mod session_runtime;
pub mod skill_resolution;
pub mod skill_tokens;
pub mod util;

pub use agy::{create_agy_plugin, parse_agy_stream_line, AgyStreamState};
pub use claude::{create_claude_plugin, format_skill_directive};
pub use cursor::{create_cursor_plugin, parse_cursor_stream_line};
pub use opencode::{create_opencode_plugin, parse_opencode_stream_line};
pub use plugin::{
    prompt_verification_needle, AgentPlugin, LaunchConfig, PluginContext, PromptDelivery,
    ReadySignal,
};
pub use registry::{resolve_plugin, SUPPORTED_CLIS};
pub use vst_types::CliId;
