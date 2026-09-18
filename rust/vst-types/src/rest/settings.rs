//! `GET /settings`, `PATCH /settings` — `routes/settings.ts`.

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

/// The full config shape returned by `GET /settings`: `MainConfig` +
/// `UserSettings` + a runtime `homeDir`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub default_projects_dir: Option<String>,
    pub skill_paths: Option<Vec<String>>,
    pub theme_id: Option<String>,
    pub markdown_style: Option<MarkdownStyle>,
    pub pid: Option<i64>,
    pub port: Option<i64>,
    pub cli_token: Option<String>,
    pub tauri_token: Option<String>,
    pub browser_epoch: Option<i64>,
    pub started_at: Option<String>,
    pub home_dir: String,
}

/// `PATCH /settings` request body (all optional).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSettingsBody {
    pub default_projects_dir: Option<String>,
    pub skill_paths: Option<Vec<String>>,
    pub theme_id: Option<String>,
    pub markdown_style: Option<MarkdownStyle>,
    /// Request-only: when `true`, clears `markdown_style` to `None` on write.
    /// Never persisted into `Settings`/a `GET /settings` response.
    pub reset_markdown_style: Option<bool>,
}

/// User-configurable Markdown overrides layered on top of the active theme's
/// `--md-*` defaults. All fields optional; absent = theme defaults.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownStyle {
    pub h1: Option<HeadingStyle>,
    pub h2: Option<HeadingStyle>,
    pub h3: Option<HeadingStyle>,
    pub h4: Option<HeadingStyle>,
    pub h5: Option<HeadingStyle>,
    pub h6: Option<HeadingStyle>,
    pub bold: Option<BoldStyle>,
    pub italic: Option<ItalicStyle>,
    pub inline_code: Option<InlineCodeStyle>,
    pub code_block: Option<CodeBlockStyle>,
    /// Shared by inline and fenced code — one field is the source of truth for
    /// both, mapping to `--md-code-font-family`.
    pub code_font_family: Option<String>,
    pub blockquote: Option<BlockquoteStyle>,
    pub link: Option<LinkStyle>,
}

/// Heading (`h1`..`h6`) style.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingStyle {
    pub size: Option<String>,
    pub color: Option<String>,
    pub weight: Option<u16>,
}

/// Bold (`strong`) style.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoldStyle {
    pub weight: Option<u16>,
    pub color: Option<String>,
}

/// Italic (`em`) style.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItalicStyle {
    pub style: Option<String>,
    pub color: Option<String>,
}

/// Inline code style (no `font_family` — see `MarkdownStyle::code_font_family`).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineCodeStyle {
    pub bg: Option<String>,
    pub color: Option<String>,
}

/// Fenced code block style (no `font_family` — see `MarkdownStyle::code_font_family`).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeBlockStyle {
    pub bg: Option<String>,
    pub color: Option<String>,
    pub border: Option<String>,
}

/// Blockquote style.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockquoteStyle {
    pub border: Option<String>,
    pub color: Option<String>,
}

/// Link style.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStyle {
    pub color: Option<String>,
}

/// `PATCH /settings` success response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSettingsResult {
    pub ok: bool,
}
