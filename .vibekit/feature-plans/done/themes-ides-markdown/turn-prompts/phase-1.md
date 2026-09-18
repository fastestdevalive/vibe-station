# Turn-implement: Phase 1 of plan-themes-ides-markdown

You are implementing **Phase 1 only** of a larger plan. Do not read or touch any other phase's files. Full plan (for your own reference only, do not implement beyond Phase 1): `.vibekit/feature-plans/pending/themes-ides-markdown/plan-themes-ides-markdown.md`

**Before touching any file:** read the `coding-agent-guardrails` skill, then the `coding` skill.

## What this feature is

Vibe-station is adding a multi-theme system (14 total UI themes) and customizable Markdown styling, stored server-side so every browser tab/session shares the same setting live. The server side is a Rust workspace under `rust/` (this repo is mid-migration from a legacy Node daemon — **never touch anything under `daemon/` or `cli/`, they are frozen**). Phase 1 is the server-side schema, validation, and WebSocket live-sync plumbing that every later phase depends on. Phases 2-5 (theme data, web-ui wiring, syntax highlighting, Markdown styling) are NOT your job and are not yet implemented — do not try to make anything past `/settings`'s Rust surface work end-to-end.

## Your checklist (mark each `[x]` in the plan file at the paths above as you complete it — find the "### Phase 1" section and edit those exact checkbox lines)

- [ ] 1.1 Extend `Settings` in `rust/vst-types/src/rest/settings.rs` with `theme_id: Option<String>`, `markdown_style: Option<MarkdownStyle>`; extend `PatchSettingsBody` with those same two fields plus `reset_markdown_style: Option<bool>` (request-only — do not add it to `Settings`, it must never appear in a `GET /settings` response); define the `MarkdownStyle` struct (+ its nested `H1..H6`/`Bold`/`Italic`/`InlineCode`/`CodeBlock`/`Blockquote`/`Link` sub-structs and the top-level `code_font_family` field) per the Data Model table below, all deriving `Clone, Debug, PartialEq, Serialize, Deserialize`; add `default_theme_id()` returning `"vibestation-dark"` in `rust/vst-routes/src/settings.rs` alongside `default_projects_dir()`/`default_skill_paths()`
- [ ] 1.2 Extend `SettingsRouteError` (`settings.rs:16-24`) with a new variant for a bad `markdown_style` shape only. `theme_id` is stored as an opaque non-empty string — validate shape only (like `defaultProjectsDir`), never against a registry list (there is no registry in Phase 1's scope). In `patch_settings`, process `reset_markdown_style: true` before applying any `markdown_style` value in the same request (clears the field to `None`, then a same-request `markdown_style` value, if present, re-sets it)
- [ ] 1.3 Add `broadcaster: Broadcaster` field to `SettingsRoutes` (`settings.rs:58-61`); change `SettingsRoutes::new(paths: Paths, broadcaster: Broadcaster)`'s signature; update both call sites (`rust/vst-daemon/src/server.rs:264`, `rust/vst-routes/tests/utility_routes.rs:153`), mirroring `ModeRoutes::new(store, broadcaster)` (`modes.rs:155`)
- [ ] 1.4 Add `ServerEvent::SettingsThemeUpdated { theme_id: Option<String>, markdown_style: Option<MarkdownStyle> }` to `rust/vst-types/src/events.rs` (narrow payload — never the full `Settings` struct, which carries `cli_token`/`tauri_token`); add the matching wire `ServerMessage::SettingsThemeUpdated` (`#[serde(rename = "settings:updated", rename_all = "camelCase")]`) to `rust/vst-types/src/ws.rs`; add the corresponding match arm to `server_event_to_message()` (`rust/vst-ws/src/broadcaster.rs:120-203`); call `self.broadcaster.send(...)` from `patch_settings` after the successful `tokio::fs::write` (mirrors `vst-routes/src/modes.rs:396-400`)
- [ ] 1.5 Confirm Node `daemon/src/routes/settings.ts` / `services/config.ts` are untouched (out of scope) — do not edit anything under `daemon/` or `cli/`
- [ ] 1.T1 Test (Rust, in `rust/vst-routes/tests/`, alongside `utility_routes.rs`): `PATCH /settings` with a bad `markdown_style` shape → `validation_error`; a valid `theme_id`/`markdown_style` → 200 + `GET /settings` reflects it; `resetMarkdownStyle: true` clears a previously-set `markdown_style`; a connected WS client receives `settings:updated` with only `themeId`/`markdownStyle`, never token fields

## Files you may touch (nothing outside this list)

- `rust/vst-types/src/rest/settings.rs`
- `rust/vst-routes/src/settings.rs`
- `rust/vst-types/src/events.rs`
- `rust/vst-types/src/ws.rs`
- `rust/vst-ws/src/broadcaster.rs`
- `rust/vst-daemon/src/server.rs`
- `rust/vst-routes/tests/utility_routes.rs`
- `rust/vst-routes/src/modes.rs` — reference only, read for the broadcast call-site pattern, do not edit
- The plan file itself, only to check off your `[x]` items

## Design Details you need (copied from the plan — Phase 2-5 material intentionally omitted)

### System Boundaries

| Boundary | Fields + types | Errors | Source of truth |
|----------|----------------|--------|-----------------|
| Web-ui ↔ Rust server (`GET/PATCH /settings`, `rust/vst-routes/src/settings.rs`) | `theme_id: Option<String>, markdown_style: Option<MarkdownStyle>, reset_markdown_style: Option<bool>` (Rust) ↔ `themeId`/`markdownStyle`/`resetMarkdownStyle` (wire JSON, camelCase via serde) | `SettingsRouteError` variant → `validation_error` — `themeId` is stored as an opaque non-empty string, no registry-list check; bad `markdownStyle` CSS-value shape is still validated (new variant alongside `DefaultProjectsDirNotAbsolute`) | server `~/.vibe-station/config.json` |
| Rust server → all browser tabs (WS) | `ServerEvent::SettingsThemeUpdated { theme_id: Option<String>, markdown_style: Option<MarkdownStyle> }` (internal, narrow — never the full `Settings` struct) → wire `{type: "settings:updated", themeId, markdownStyle}` via `server_event_to_message()` (`vst-ws/src/broadcaster.rs:120-203`, a hand-written exhaustive `match`, not a `From` impl) | none (best-effort push) | server (push) |
| `themeId` → theme data | registry lookup (Phase 2, not your concern), not transmitted over the wire | unknown id → client-side fallback (Phase 3, not your concern) | n/a for Phase 1 |
| Node `daemon/` (legacy, parallel) | unchanged — `themeId`/`markdownStyle` intentionally absent | n/a | frozen; do not touch |

### Data Model

| Entity | Field | Type | Constraints | Notes |
|--------|-------|------|-------------|-------|
| `Settings` / config.json | `theme_id` | `Option<String>` (wire: `themeId: string`) | non-empty string only — not validated against a registry id list, default `"vibestation-dark"` | mirrors `skill_paths` optionality pattern |
| `Settings` / config.json | `markdown_style` | `Option<MarkdownStyle>` (wire: `markdownStyle?`) | all fields optional; absent = theme defaults | merge-on-write like `skill_paths` (`settings.rs:158-167`) |
| `PatchSettingsBody` (request only, not persisted) | `reset_markdown_style` | `Option<bool>` (wire: `resetMarkdownStyle?`) | when `true`, clears `markdown_style` to `None` on write, processed before any `markdown_style` field in the same request is applied | request-only; never appears in `GET /settings`'s response |
| `MarkdownStyle` | `h1..h6` | `{ size: Option<String>, color: Option<String>, weight: Option<u16> }` | CSS length/color validated by regex in the route handler | maps to `--md-h1-size` etc. |
| `MarkdownStyle` | `bold` | `{ weight: Option<u16>, color: Option<String> }` | | maps to `--md-bold-weight/color` |
| `MarkdownStyle` | `italic` | `{ style: Option<String> ("italic"\|"oblique"), color: Option<String> }` | | maps to `--md-italic-style/color` |
| `MarkdownStyle` | `inline_code` | `{ bg: Option<String>, color: Option<String> }` | no `font_family` field | maps to `--md-inline-code-bg/color` |
| `MarkdownStyle` | `code_block` | `{ bg: Option<String>, color: Option<String>, border: Option<String> }` | no `font_family` field | maps to `--md-code-block-bg/color/border` |
| `MarkdownStyle` | `code_font_family` | `Option<String>` | single top-level field, shared by inline and fenced code | maps to `--md-code-font-family` |
| `MarkdownStyle` | `blockquote` | `{ border: Option<String>, color: Option<String> }` | | maps to `--md-blockquote-border/color` |
| `MarkdownStyle` | `link` | `{ color: Option<String> }` | | maps to `--md-link-color` |

`MarkdownStyle` (and every struct nested inside it) derives `Clone, Debug, PartialEq, Serialize, Deserialize` — required because `MarkdownStyle` also appears inside `ServerEvent::SettingsThemeUpdated`/`ServerMessage::SettingsThemeUpdated`.

### API Contracts

- `GET /settings` (`rust/vst-routes/src/settings.rs:82-128`) → `get_settings` adds `theme_id: Option<String>`, `markdown_style: Option<MarkdownStyle>` to the `Settings` struct it returns (defaulting `theme_id` via a new `default_theme_id()` fn alongside the existing `default_projects_dir()`/`default_skill_paths()` at lines 36-55). `reset_markdown_style` never appears here — it's request-only.
- `PATCH /settings` (`settings.rs:130-190`) → `PatchSettingsBody` gains `theme_id: Option<String>` (opaque, shape-only validated), `markdown_style: Option<MarkdownStyle>` (CSS-value shape validated), `reset_markdown_style: Option<bool>` (when `true`, clears `markdown_style` to `None`, applied before any `markdown_style` value in the same request); failures return a new `SettingsRouteError` variant (alongside `DefaultProjectsDirNotAbsolute`/`SkillPathsNotAbsolute`, lines 16-24) mapped to `error_code() == "validation_error"` same as today
- `SettingsRoutes` gains a `broadcaster: Broadcaster` field; `SettingsRoutes::new(paths: Paths, broadcaster: Broadcaster)` (signature change — 2 call sites to update: `vst-daemon/src/server.rs:264`, `vst-routes/tests/utility_routes.rs:153`), mirroring `ModeRoutes::new(store, broadcaster)` (`modes.rs:155`)
- New WS server→client event, narrow payload, not the full `Settings` struct: `ServerEvent::SettingsThemeUpdated { theme_id: Option<String>, markdown_style: Option<MarkdownStyle> }` (`vst-types/src/events.rs`) + matching `ServerMessage` wire variant `{ type: "settings:updated", themeId, markdownStyle }` (`vst-types/src/ws.rs`) — requires a new arm in `server_event_to_message()` (`vst-ws/src/broadcaster.rs:120-203`) — broadcast via `self.broadcaster.send(...)` right after `patch_settings`'s successful `tokio::fs::write` (after line 189), following `vst-routes/src/modes.rs:396-400` / `:504`'s exact call pattern

## When you're done

- Mark items 1.1-1.5 and 1.T1 `[x]` in the plan file's Phase 1 checklist section (`.vibekit/feature-plans/pending/themes-ides-markdown/plan-themes-ides-markdown.md`)
- Write a short `## Key Decisions` note at the bottom of this prompt file (`.vibekit/feature-plans/pending/themes-ides-markdown/turn-prompts/phase-1.md`) recording any deviation from the above or any decision you had to make that a later phase's agent might need to know
- Do NOT run `cargo test` yourself as a completion gate — just make sure it compiles (`cargo check -p vst-routes -p vst-types -p vst-ws -p vst-daemon`) and report what you did. The orchestrator runs the real verify pass independently after you're done.
- Report back concisely: what you changed, any deviation from the plan, and the `cargo check` result.

## Key Decisions

- **`theme_id` empty → reuses `InvalidMarkdownStyle`.** The plan mandated exactly ONE new `SettingsRouteError` variant (for a bad `markdown_style` shape). `theme_id` still needs shape validation ("opaque non-empty string", like `defaultProjectsDir`), so an empty `theme_id` is rejected with the same single new `InvalidMarkdownStyle` variant — which correctly maps to `validation_error`/`BAD_REQUEST`. No separate theme_id-specific variant was added, per the plan's "one variant only" instruction. If a later phase wants a distinct error message for empty theme id, add a dedicated variant then.
- **`server.rs:2285` gained a match arm (beyond the call-site update).** The plan listed `rust/vst-daemon/src/server.rs` only for the `SettingsRoutes::new(...)` call-site change (line 264), but adding `InvalidMarkdownStyle` to `SettingsRouteError` made the exhaustive HTTP-status `match` at line ~2285 non-exhaustive — a compile error. I added `| SettingsRouteError::InvalidMarkdownStyle` to the existing `BAD_REQUEST` arm. Same file, required for compilation.
- **Broadcast is not gated on theme/markdown actually changing.** `patch_settings` sends `SettingsThemeUpdated` on every successful write (per the plan's "send after the successful `tokio::fs::write`"), carrying the *resulting* `theme_id`/`markdown_style` (post-reset/post-apply). For a PATCH that only touches e.g. `defaultProjectsDir`, this pushes the current (unchanged) theme/markdown — harmless, and matches the plan's literal instruction.
- **Reset implementation detail.** `reset_markdown_style: true` clears the field by **removing** the `markdownStyle` key from `config.json` (not writing JSON `null`), so a subsequent `GET /settings` returns `markdownStyle` absent → `None`. The order (reset first, then any same-request `markdown_style` re-applied) is honored.
- **`MarkdownStyle`/nested structs use `rename_all = "camelCase"`**, so the wire keys are `inlineCode`/`codeBlock`/`codeFontFamily`/etc., matching the plan's `markdownStyle` contract; nested `HeadingStyle`/`BoldStyle`/etc. fields are already single lowercase words so camelCase is a no-op there.
