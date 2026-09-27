<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: CLI Plugin Default Channel

> Make each `AgentPlugin` declare its own default execution channel (`agy` → `tmux`, everything else → `json`), and thread that default through the daemon, CLI, web-ui, and docs instead of hardcoding `tmux`/`json` at each call site.

**Issue:** cli-plugin-default-channel
**Branch:** `feat/cli-plugin-default-channel`
**Status:** Implemented (3 review rounds; see `review-round-1.md`, `review-round-2.md`, `review-round-3.md`)
**PRD:** none (small, mechanical feature — no PRD)

**Reference files:**
- Trait: `rust/vst-agents/src/plugin.rs:237` (`trait AgentPlugin`)
- Daemon session create: `rust/vst-routes/src/sessions.rs:630` (`create_normal_session`)
- Daemon worktree create: `rust/vst-routes/src/worktrees.rs:507` (`create_worktree`)
- CLI: `rust/vst-cli/src/commands/agent/create.rs`, `rust/vst-cli/src/commands/worktree/create.rs`
- UI: `web-ui/src/components/draft/DraftComposer.tsx:162-273`

---

## Superseded

| Prior approach | Why it failed | Superseded on |
|-----------------|---------------|----------------|
| Draft #1: UI branched on `selectedCli === "agy"`; "touched" ref inferred from `initialConfig?.channel != null`; CLI inheritance behaviour change left undocumented; no mode-name-vs-id fix, no panic guard, no draft-start default fix | claude-opus review round 1 (`review-round-1.md`) found 3 blocking issues (B1-B3) and 5 major issues (M1-M5) — see that file for full detail; every finding is folded into this revision | 2026-09-27 (round 1 review) |
| Draft #2 (per-CLI default-channel override): `BTreeMap<CliId, Channel>` with no `Ord` derive (doesn't compile); override written straight into `Settings` with no `PatchSettingsBody` field (unwritable, no way to clear); Phase 2 depending on a `Settings` field Phase 6 added; `settings_routes` injected as a struct field into `SessionRoutes`/`WorktreeRoutes`/`ModeRoutes` (breaks ~25 existing constructor/`Clone`-impl/test-literal sites across 8+ files for no benefit over a free function); `POST /projects/create`'s two hardcoded `Channel::Tmux` sites missed entirely; whole-map override deserialization (one bad key silently drops all overrides); write-time-only `supports_json` gate with no seam to test it and no protection if a plugin's capability changes after the override was set; `Channel::Pty` not excluded from the override's valid values | claude-opus review round 2 (`review-round-2.md`) found 3 blocking issues (B1-B3) and 5 major issues (M1-M5) — every finding is folded into this revision | 2026-09-27 (round 2 review) |

---

## Problem & Concept

- Channel defaulting is currently hardcoded per call site (`Channel::Json` in most daemon/UI paths, `"tmux"` in the CLI's `AgentCreateOptions`/`WorktreeCreateOptions` defaults) — no single place says "this CLI's natural default is X".
- `AgentPlugin` (`rust/vst-agents/src/plugin.rs`) is already the sole extension point for CLI-specific behaviour (`AGENTS.md` § Agent plugin) — channel default belongs there, not in an `if cli == "agy"` scattered across routes/CLI/UI.
- Success: adding a 5th CLI plugin *must* fail to compile until its author picks a default channel — the trait enforces the decision, calling code never inspects `CliId` again.

## Out of Scope

- Changing the actual `Channel` enum values or adding a third channel type.
- Removing subagent channel *inheritance* itself — it stays; only its trigger condition changes (see Requirement 3a / Decision 7 — round-1 review B3: the CLI side of inheritance is **not** already correct, it is *newly enabled* by this plan, and that is now called out as an explicit behaviour change, not a no-op).
- Changing `--channel=pty` (still unsupported/rejected by the CLI, unrelated to this feature).
- Retroactively changing already-created sessions/worktrees (channel is fixed at creation time; no migration).
- Any per-CLI override of anything **other than** the default channel (e.g. default model, default mode) — out of scope for this plan; the settings surface being added (Requirements 10-12) is specifically the channel.

## Requirements

| # | Requirement |
|---|-------------|
| 1 | `AgentPlugin` gets a new **required** method `fn default_channel(&self) -> Channel;` — no default body, so every existing and future plugin must implement it. This is the plugin's **hardwired base default**, always available even with no user override. |
| 2 | `claude`, `cursor`, `opencode` plugins return `Channel::Json`; `agy` returns `Channel::Tmux`. |
| 3 | Daemon: an agent session with no explicit/inherited channel resolves its default via the **effective** default channel for `mode.cli` (user override if set, else `resolve_plugin(mode.cli).default_channel()` — see Requirement 11), not a hardcoded `Channel::Json`. Terminal-type sessions (`SessionType::Terminal`) always default to `Channel::Tmux`, unaffected by mode/plugin/override. Mode-name (not just mode-id) inputs must resolve to the same canonical mode used for the default lookup (round-1 M1). |
| 3a | Subagent channel inheritance (CLI-spawned, `source_agent_id` set) is **newly exercised** end-to-end by this plan (round-1 B3) — when the child's mode resolves to the same CLI as the parent (including "no `--mode` passed", which always inherits the parent's mode), the child inherits the parent's channel; when an explicit `--mode` names a *different* CLI, the child gets that CLI's own effective default, never the parent's channel (see Decision 6). |
| 4 | Daemon: `create_worktree` resolves the same way when `body.channel` is `None` (mode is always required for a worktree, so this always has a mode to resolve). |
| 5 | CLI: `--channel` becomes optional on `vst agent create` / `vst worktree create` — omitted ⇒ send `channel: None` to the daemon (let it resolve); passed ⇒ validate and send `Some(Tmux\|Json)` exactly as today. |
| 6 | Web UI: a draft's channel radio defaults to match the selected mode's CLI's **effective** default (`agy` → Terminal, else → Rich Chat, unless overridden — see Requirement 11) whenever the user hasn't explicitly chosen a channel — determined via a server-exposed `defaultChannel` per CLI (round-1 B2: the UI must never branch on a literal `"agy"` string). |
| 7 | Docs (`skill/SKILL.md`, both `rust/vst-agents/assets/*.md`) describe the new per-CLI default instead of "sessions default to tmux", **and** explicitly call out the CLI subagent-inheritance behaviour change (Requirement 3a). |
| 8 | All existing mock/stub `AgentPlugin` impls (tests + `modes.rs` test doubles) compile — each declares a channel. |
| 9 | Settings UI: rename the "Modes" section to **"Agents & modes"** (label only — section `id`/route stays `modes` so existing deep links keep working). |
| 10 | Settings UI: a detected-CLI row (`CliDetectionPanel`, `variant="settings"` only) gets a **"Default channel"** dropdown (Rich Chat / Terminal (tmux)) — **shipped shape differs from the original wording** (round-3 P1): a `<Select>`, not the two-radio shape DraftComposer uses; pinned to the row's far right alongside the create/recreate-bundle button, same row at any viewport width; shown only once at least one mode exists for that CLI **or** the CLI already has a live override (`hasAnyMode \|\| defaultChannelOverridden`) — a CLI with zero modes and no override shows nothing there. The "✓ all created" label (unrelated to this field, but touched by the same row restructure) was dropped for the settings variant and kept for `oobe` only. |
| 11 | The per-CLI default-**channel** override is persisted (`Settings.defaultChannelByCli`, `PatchSettingsBody.defaultChannelByCli` — a **separate, writable** field, not just a read-only addition to `Settings`), validated on write (`Json` rejected for a CLI whose plugin doesn't `supports_json()`; `Pty` always rejected — the override's valid range is exactly `{Tmux, Json}`, never all of `Channel`), and resolved through **one** shared, total (never worse than "no override") daemon helper: override if present and still valid, else the plugin's own `default_channel()` (Requirement 1). Per-key merge semantics on write (a `null` value clears that CLI's override; other keys are untouched) — never a whole-map replace. |
| 12 | Every consumer of "this CLI's default channel" in this plan (Requirement 3's session/worktree defaulting including `POST /projects/create`'s `startAgent` path, Requirement 6's `GET /supported-clis` field) reads the **same** effective-default helper — none of them calls `plugin.default_channel()` directly and skips the override. |

---

## Change Map

```
rust/vst-agents/src/
  plugin.rs        ~ add default_channel() to trait (the plugin's hardwired base default)
  claude.rs        ~ impl default_channel -> Json
  cursor.rs        ~ impl default_channel -> Json
  opencode.rs      ~ impl default_channel -> Json
  agy.rs           ~ impl default_channel -> Tmux
  registry.rs      ~ +invariant test (M4)
rust/vst-routes/src/
  sessions.rs      ~ create_normal_session + draft-start resolve EFFECTIVE default (override ?? plugin) (M1/M3)
  worktrees.rs     ~ create_worktree resolves effective default, mode-first ordering
  modes.rs         ~ stub macro + 2 test plugins get default_channel; +resolve_effective_default_channel; list_supported_clis exposes defaultChannel (now override-aware)
  settings.rs      ~ +defaultChannelByCli validation (rejects Json override for a !supports_json CLI)/persistence
rust/vst-types/src/
  rest/modes.rs    ~ +default_channel on SupportedCli
  rest/settings.rs ~ +default_channel_by_cli on Settings
rust/vst-cli/src/commands/
  agent/create.rs      ~ channel: Option<String>, send None when absent
  worktree/create.rs   ~ channel: Option<String>, send None when absent
web-ui/src/components/
  draft/DraftComposer.tsx        ~ channel default follows selected mode's cli (via defaultChannel, not a literal check)
  settings/SettingsPanel.tsx     ~ rename "Modes" label -> "Agents & modes"
  agent/CliDetectionPanel.tsx    ~ +per-CLI "Default channel" selector (settings variant)
web-ui/src/api/
  types.ts         ~ +channelExplicit on DraftConfig; +defaultChannel on SupportedCli; +defaultChannelByCli on Settings
skill/
  SKILL.md             ~ §5/§6 channel-default wording + inheritance-change callout
rust/vst-agents/assets/
  agent-system-prompt.md        ~ document default-channel behavior
  agent-subagent-richchat.md    ~ correct "tmux is the worktree-create default" claim
docs/
  API-CONTRACT.md         ~ correct stale --channel/--json docs (M5)
  SESSION-EXECUTION.md    ~ per-CLI default note (M5)
AGENTS.md                 ~ +default_channel() row in plugin methods table (M5)
```

| Today | After this plan |
|-------|-----------------|
| Channel default is `Channel::Json` (or CLI's own `"tmux"` string) hardcoded per call site | Channel default is the **effective** default for `mode.cli` — a user override (if set) else `resolve_plugin(mode.cli).default_channel()` — resolved through one helper |
| `vst agent create` / `vst worktree create` always sends an explicit `channel` (defaulting to `"tmux"` client-side) — subagent channel inheritance is dead code from the CLI | Omitting `--channel` sends `channel: None`; the daemon resolves the effective default **or**, for a CLI-spawned subagent whose mode's CLI matches the parent's, inherits the parent's channel — this is a real, newly-visible behaviour change |
| A 5th CLI plugin compiles fine without ever deciding its default channel | A 5th CLI plugin **does not compile** until `default_channel()` is implemented |
| DraftComposer's channel radio always initializes to `"json"` regardless of mode, and any per-CLI logic would have to check `selectedCli === "agy"` | DraftComposer defaults to Terminal for a CLI whose server-reported `defaultChannel` (override-aware) is `"tmux"`, Rich Chat otherwise, once the user hasn't explicitly chosen — no CLI-id string check in UI code |
| Settings has one "Modes" section with no per-CLI override of anything | Settings section is "Agents & modes"; each detected CLI has an explicit, overridable **default channel** selector, backed by the same effective-default helper the daemon uses for every session/worktree create |

---

## Research

- `rust/vst-agents/src/plugin.rs:237,254-258` — `AgentPlugin` trait's 4 required methods (`get_launch_command`, `get_environment`, `get_ready_signal`, `compose_launch_prompt`); new method joins this required set, no default body, matching the existing pattern.
- `rust/vst-agents/src/registry.rs:33` — `resolve_plugin(cli: CliId) -> Box<dyn AgentPlugin>` is the one-stop resolver already used everywhere; no new resolution mechanism needed.
- `rust/vst-routes/src/sessions.rs:630-679` — `create_normal_session`'s channel resolution ladder: `data.channel` (explicit) → `inherited_channel` (subagent inherits parent) → `defaulted_channel` (currently `Terminal ? Tmux : Json`, hardcoded) → `resolve_use_tmux` fallback. Only the `defaulted_channel` step changes; explicit/inherited paths are untouched (Requirement constraint: subagent inheritance stays correct).
- `rust/vst-routes/src/sessions.rs:1164,1198,2630,3723` (and others) — every other call site that needs a plugin already does `find_mode(&mode_id)` → `resolve_plugin(mode.cli)`; same two-call pattern reused here.
- `rust/vst-routes/src/worktrees.rs:531-540` — `create_worktree`'s channel line (531) currently runs **before** `mode_id` is resolved (538); mode_id resolution must move earlier (or channel resolution move later) since the plugin default needs `mode.cli`.
- `rust/vst-routes/src/worktrees.rs:786` — an existing later call site in the same file already does `resolve_plugin(mode.cli)` off a resolved `Mode` — confirms the same pattern is available once `mode_id` is resolved.
- `rust/vst-cli/src/commands/agent/create.rs:9-33,120-131` — `AgentCreateOptions.channel: String` defaults to `"tmux".to_string()`; `run_agent_create` unconditionally matches it into `Some(Channel::...)` sent in the body (line ~164 `channel: Some(channel)`). No "was `--channel` passed?" bit currently exists — needs to become `Option<String>` (`None` default) to distinguish "not passed" from "explicitly tmux".
- `rust/vst-cli/src/commands/worktree/create.rs:16-42,133-145` — same shape/bug as above, `channel: String = "tmux"`.
- `rust/vst-cli/tests/worktree_project_file_daemon_contract.rs:68,98` and `rust/vst-cli/tests/session_mode_contract.rs:112-162,605,619` — existing contract tests assert `opts.channel == "tmux"`/`"json"` as `String`; these break by construction once the field type changes to `Option<String>` and must be updated to `Option<"tmux".into())`/`None`.
- `web-ui/src/components/draft/DraftComposer.tsx:162-273` — `channel` state initializes once from `initialConfig?.channel` (falls back to `"json"` unconditionally, ignoring the mode); `selectedCli`/`jsonSupported` are computed later (line 264) purely to force-flip Rich-Chat-unsupported CLIs to `"terminal"` — no existing logic ever defaults *to* `"terminal"` for a CLI that merely prefers it (agy).
- `web-ui/src/components/layout/LeftSidebar.tsx:1128` and `ProjectHomeTab.tsx:35` — both set `draftConfig: { ..., channel: "json" }` as a scaffold value *before* any mode is chosen (mode selection happens inside `DraftComposer`); this is a placeholder, not the final default — the real per-mode default resolution belongs in `DraftComposer`, so these two lines do not need to change.
- `skill/SKILL.md:103-105` — states "Sessions default to a tmux-backed terminal channel" unconditionally for `vst agent create`/`vst worktree create`; false after this change for claude/cursor/opencode modes.
- `rust/vst-agents/assets/agent-subagent-richchat.md:66-74` — already documents the *agy exception* to a tmux-is-the-worktree-create-default assumption; needs rewording once the default is per-CLI rather than always tmux.
- `rust/vst-routes/src/modes.rs:819-850` (`stub_plugin_base!` macro used by `FailingModelsPlugin`/`PartialModelsPlugin`) and `rust/vst-agents/src/json_agent_session/mod.rs:1069` (`NoopPlugin`) and `rust/vst-agents/tests/json_agent_session_queue.rs:68,228` (`MockTurnPlugin`, `HangingTurnPlugin`) — 5 test-only `AgentPlugin` impls across 3 files; all 5 fail to compile once `default_channel` becomes required and must each gain an implementation (macro covers 2 of them in one edit).
- **Root cause:** channel defaulting was implemented ad hoc, once per surface (daemon route, CLI option default, UI initial state), before `agy` (whose natural channel is `tmux`, unlike the other three CLIs) existed as a plugin — nothing was structurally wrong until a CLI with a different natural default showed up.

### Round-1 review additions (B1-B3, M1-M5 — see `review-round-1.md`)

- **B1 (UI "touched" ref is dead code):** `web-ui/src/components/layout/LeftSidebar.tsx:1128` and `web-ui/src/lib/projectDraft.ts:35` (not `ProjectHomeTab.tsx:35` — that line has no such literal; the original Research citation was wrong) both seed a fresh draft with `channel: "json"` *before any mode is chosen*. Since `initialConfig.channel` is present on first mount, `channelTouchedRef` (as originally designed) is `true` immediately, so the mode-follow effect never runs for either entry point. `DraftComposer.tsx:276-281`'s `currentConfig` always serialises `channel`, and the autosave effect (`:360-363`, debounced via `scheduleSave` at `:342-345`) persists it ~1.2s after mount regardless of user action — so even a from-scratch draft looks "touched" on reopen. The Tier-2→Tier-1 upgrade path (`:419-424`, `draftConfig: { ...currentConfig, entryPoint: "global" }`) carries the same false-touched `channel` forward.
- **B1 fix requires a new field, not a smarter inference:** `channelExplicit?: boolean` must be added to `DraftConfig` in both `web-ui/src/api/types.ts:203-207` (TS) **and** `rust/vst-types/src/domain.rs:491-494` (Rust) — `sessions.rs` deserializes `draft_config` into the typed Rust struct, so a TS-only field is silently dropped on any daemon round-trip (draft autosave → reload).
- **B2 (no CLI-id literals in UI):** `AGENTS.md` § Agent plugin's own invariant ("never branch on CLI id outside the plugin") is violated by checking `selectedCli === "agy"` in `DraftComposer.tsx`. The existing `supportsJson: boolean` field on `SupportedCli` (`rust/vst-types/src/rest/modes.rs:11-20`, populated in `rust/vst-routes/src/modes.rs:303-341`'s `list_supported_clis`) is the established precedent for exposing a plugin-derived capability over `GET /supported-clis` instead of hardcoding CLI ids client-side — `default_channel` follows the same path as a new `default_channel: Channel` field (camelCase `defaultChannel` over the wire), filled via `plugin.default_channel()` in the same function.
- **B3 (CLI inheritance was never reachable):** `rust/vst-cli/src/commands/agent/create.rs` today always sends `channel: Some(channel)` (never `None`), so `sessions.rs:647-649`'s `if data.channel.is_none() { inherited_channel = ... }` branch is dead for every CLI-originated request — CLI-spawned subagents have never actually inherited the parent's channel, contrary to what `agent-subagent-richchat.md:43-44` already claims. After this plan, omitting `--channel` makes inheritance reachable for the first time, which is the plan's biggest real behaviour change and must be documented as such, not waved off as "already correct" (the original Out-of-Scope line 44 was wrong).
- **B3 also collides with the agy default:** `agent-subagent-richchat.md:72-75` tells a Rich-Chat-channel agent to pass `--channel=tmux` explicitly when spawning an `agy` subagent — i.e. the *documented* intent is that an agy child should default to `Tmux` even from a `Json` parent. Newly-reachable inheritance must not silently override that: inheritance should only win when the child's mode resolves to the **same CLI** as the parent (see Decision 7).
- **M1 (mode name vs id ordering bug):** `rust/vst-routes/src/modes.rs:92-101,119-121` — `resolve_mode_id` accepts either a mode **id or name**; `find_mode` matches **id only**. In `create_normal_session`, `defaulted_channel` (`sessions.rs:660-668`, as drafted) runs *before* the `resolve_mode_id` canonicalisation at `:687-694`, so `vst agent create --mode=<name-form>` with an unresolved name form causes `find_mode` to miss, falling back to `Json` even for an `agy` mode. The fallback is reachable, not the "unreachable in practice" case the first draft assumed.
- **M2 (panic risk):** `resolve_mode_id` and `find_mode` each call `load_modes()` (a separate disk read). Decision 2's original `find_mode(&mode_id).expect("resolve_mode_id already validated existence")` has a real TOCTOU window — a mode deleted/renamed between the two calls panics the request handler instead of erroring.
- **M3 (draft-start paths still hardcode `Json`):** `rust/vst-routes/src/sessions.rs:1881,2025` (`start_new_worktree` / existing-worktree-or-tab start) do `draft_config.channel.unwrap_or(Channel::Json)` — Requirement 3's guarantee does not hold for `POST /sessions/:id/start` when the draft's `draftConfig.channel` is absent, which becomes the common case once B1's placeholder `channel: "json"` scaffolding is reconsidered. `:228` and `:4616` are placeholder values for a `drafting`-state `SessionRecord` view/construction, not a resolved default — leave those two as-is with a comment, per the reviewer's note.
- **M4 (missing invariant):** `rust/vst-agents/src/plugin.rs:317-319` — `supports_json()` defaults to `false`. A future plugin returning `default_channel() -> Json` without also implementing `supports_json() -> true` would 400 on every default-path create (`sessions.rs:695-704`, `worktrees.rs:542-554`'s existing json-unsupported gate) — worse than today's behaviour for that plugin.
- **M5 (stale docs):** `docs/API-CONTRACT.md:24,35` (documents a non-existent worktree-create `--json` flag and "`--channel` selects tmux (default)"), `docs/SESSION-EXECUTION.md:5` ("tmux mode (default)" heading), `AGENTS.md` § "Current plugin methods" table (no `default_channel()` row — that table is the canonical plugin-method list this repo's own guidelines point to).
- `rust/vst-routes/src/settings.rs:16-30` (`SettingsRouteError`), `:60-77` (`effective_skill_paths`) — established pattern for a new settings field: validate on `PATCH /settings`, resolve via one helper shared between daemon startup and the route handler. `defaultChannelByCli` follows the same shape (validate on write, resolve via one shared helper).
- `web-ui/src/components/settings/SettingsPanel.tsx:34` — `{ id: "modes", label: "Modes", content: <ModesSetting api={api} /> }`; only `label` changes to `"Agents & modes"` — `id` stays `"modes"` so `/settings/modes` deep links are unaffected.
- `web-ui/src/components/agent/CliDetectionPanel.tsx:23-30,55-` — already fetches `supportedClis` on mount (`getSupportedClis()`) and renders one row per `SupportedCli`; a per-row default-channel `<select>` (Terminal/Rich Chat) needs no new fetch, just two radio/select options within the existing row, gated to `variant === "settings"` (the `oobe` variant is informational-only and should not expose the override).
- `rust/vst-routes/src/modes.rs:303-341` (`list_supported_clis`) — the one function that already maps `CliId -> SupportedCli`; natural home for the effective-default-aware `default_channel` field (Decision 5 already routes it here for B2 — this plan's override support extends the same call site, not a new one).
- **Round-2 correction to this bullet's original claim:** `SessionRoutes` is **not** `#[derive(Clone)]` — it has a hand-written `Clone` impl (`sessions.rs:309-337`) that re-snapshots `direct_ptys` on every clone (round-2 m5). Any new field added to it (a design this plan does **not** end up taking, per Decision 8's round-2 revision) would need that impl edited by hand, plus threading through 10 struct-literal test sites and the `ModeRoutes::new`/`WorktreeRoutes::new` constructors' 14 more call sites. This is exactly why Decision 8 resolves the override via a free function instead (see Decision 8, round-2 M1) — `SettingsRoutes` being cheaply `Clone`-able was never in question, the cost was always in the *other* three structs.
- `rust/vst-routes/src/modes.rs:184-206,230-233` (`ModeRoutes`'s `plugin_resolver: fn(CliId) -> Box<dyn AgentPlugin>` test-seam field, set via `with_plugin_resolver`) — `SessionRoutes`/`WorktreeRoutes` call the free function `resolve_plugin` directly at their own call sites (no resolver field there today); the new effective-default helper takes an already-resolved `&dyn AgentPlugin` as a parameter, so it doesn't need its own resolver seam beyond what each struct already has. `validate_default_channel_overrides` (Decision 8, Phase 6) *does* need its own `resolver: fn(CliId) -> Box<dyn AgentPlugin>` parameter, purely so its unit test can inject a stub CLI with `supports_json() == false` (round-2 M4) — no production `CliId` has that property, so the real `resolve_plugin` alone can't exercise the rejection branch.

---

## Architecture Diagram

_Single boundary change (adds one trait method + its 4 call sites); one line suffices, no diagram needed._

`vst-cli` → `POST /sessions` or `POST /worktrees` (channel now optional) → `vst-routes` resolves `mode.cli` → `resolve_effective_default_channel(overrides_from_settings, cli, resolve_plugin(cli))` → persisted `Channel` on the new `SessionRecord`/`WorktreeRecord`. Settings UI writes `overrides` via `PATCH /settings`; both paths converge on the same helper.

---

## Design Details

### System Boundaries

| Boundary | Fields + types | Errors | Source of truth |
|----------|----------------|--------|-----------------|
| CLI ↔ Daemon (`POST /sessions`) | `channel: Option<Channel>` (was `Option<Channel>` already server-side; CLI now actually sends `None`) | unchanged — `400` on invalid mode, `422 NOT_GIT` unaffected | Daemon resolves final channel; CLI never guesses |
| CLI ↔ Daemon (`POST /worktrees`) | `channel: Option<Channel>` | unchanged | Daemon resolves final channel via `mode.cli` |
| Module ↔ Module (`vst-routes` ↔ `vst-agents`) | `AgentPlugin::default_channel(&self) -> Channel` | — (pure function, no error path) | Each plugin owns its own hardwired base default |
| Settings UI ↔ Daemon (`PATCH /settings`) | `defaultChannelByCli: Option<BTreeMap<CliId, Channel>>` | `400 validation_error` if an entry sets `Channel::Json` for a CLI whose plugin `!supports_json()` | `~/.vibe-station/config.json`, same file/route as `skillPaths`/`themeId` — daemon-owned, CLI never reads this file directly |
| Module ↔ Module (`vst-routes::modes` ↔ `vst-routes::sessions`/`worktrees`) | `resolve_effective_default_channel(overrides: &BTreeMap<CliId, Channel>, cli: CliId, plugin: &dyn AgentPlugin) -> Channel` | — (pure function, no error path — caller already validated the plugin/mode) | One helper; every default-channel consumer (session/worktree create, draft-start, inheritance fallback, `list_supported_clis`) calls into it — none re-derives the override-vs-plugin fallback |

### Key Decisions

#### Decision 1: No default body on the trait method

- **Decision:** `fn default_channel(&self) -> Channel;` has no default implementation.
- **Rationale:** matches the existing required-method pattern (`get_launch_command` et al. — see Research § plugin.rs:237) and is the entire point of Requirement 1 (compile-time enforcement for future plugins).
- **Where:** `rust/vst-agents/src/plugin.rs:258` (insert immediately after `compose_launch_prompt`, keeping required methods grouped).

#### Decision 2: `create_worktree` must resolve `mode_id` before computing `channel` — and must not panic doing it (M1/M2 fix)

- **Decision:** reorder `rust/vst-routes/src/worktrees.rs` so `resolve_mode_id(mode_id_input)` (currently line 538) runs *before* the channel line (currently line 531); add a new `modes::resolve_mode(input: &str) -> Option<Mode>` helper that loads `modes.json` **once** and returns the full canonicalized `Mode` (id-or-name match, same lookup `resolve_mode_id` already does), replacing the separate `resolve_mode_id` + `find_mode` two-call sequence everywhere a caller needs both. No `.expect()` anywhere in this path — an unresolvable mode is `WorktreeRouteError::Validation`, not a panic.
- **Rationale:** the plugin default needs `mode.cli`, which doesn't exist until the mode resolves; a separate `resolve_mode_id` then `find_mode` call is both an M1 correctness bug (id-only `find_mode` misses a valid name-form input that `resolve_mode_id` would have accepted) and an M2 TOCTOU panic risk (two separate `load_modes()` disk reads racing a concurrent mode delete/rename) — one combined helper fixes both by construction, and removes a duplicate disk read as a side benefit.
- **Where:** `rust/vst-routes/src/worktrees.rs:524-540`, new helper in `rust/vst-routes/src/modes.rs` near `resolve_mode_id` (`:92-101,119-121`).

```rust
// modes.rs — new helper, replaces the resolve_mode_id + find_mode two-call sequence.
// TWO-PASS, matching resolve_mode_id's existing semantics exactly (round-2 m1): id
// takes priority over name across the WHOLE list, not first-match-wins in one pass —
// otherwise a mode whose *name* collides with another mode's *id* can resolve
// differently here than resolve_mode_id resolves it elsewhere, computing the default
// channel from the wrong mode.
pub fn resolve_mode(input: &str) -> Option<Mode> {
    let modes = load_modes();
    modes.iter().find(|m| m.id == input)
        .or_else(|| modes.iter().find(|m| m.name == input))
        .cloned()
}

// settings.rs — free fn, same shape/location convention as modes::load_modes()
// (home_dir()-rooted, honours with_home() in tests — round-2 M1/M5). Per-entry
// parsing (round-2 M3): one unrecognized CliId key must not drop every other
// override in the map.
pub fn load_default_channel_overrides() -> BTreeMap<CliId, Channel> {
    let path = home_dir().join(".vibe-station").join("config.json");   // same root load_modes() reads modes.json from
    let raw: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    raw.get("defaultChannelByCli")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| {
                    let cli = serde_json::from_value::<CliId>(serde_json::Value::String(k.clone())).ok()?;
                    let ch = serde_json::from_value::<Channel>(v.clone()).ok()?;
                    Some((cli, ch))
                })
                .collect()
        })
        .unwrap_or_default()
}

// modes.rs — pure, no I/O, TOTAL: never returns a worse result than "no override"
// (round-2 M4) — a persisted Json override for a CLI that later loses supports_json,
// or a stray Pty, both silently fall back to the plugin default instead of 400ing
// every default-path create.
pub fn resolve_effective_default_channel(
    overrides: &BTreeMap<CliId, Channel>,
    cli: CliId,
    plugin: &dyn AgentPlugin,
) -> Channel {
    match overrides.get(&cli).copied() {
        Some(Channel::Json) if !plugin.supports_json() => plugin.default_channel(),
        Some(ch @ (Channel::Tmux | Channel::Json)) => ch,
        _ => plugin.default_channel(),   // None, or a stray Pty
    }
}

// worktrees.rs — mode resolved before channel, no expect(), override-aware.
// No settings_routes field/DI needed (round-2 M1 — the free fn above reads
// config.json directly, same root load_modes() already reads modes.json from).
let mode = resolve_mode(mode_id_input)
    .ok_or_else(|| WorktreeRouteError::Validation(format!("Mode '{mode_id_input}' not found")))?;
let overrides = load_default_channel_overrides();
let channel = body.channel.unwrap_or_else(|| match body.use_tmux {
    Some(use_tmux) => resolve_channel(resolve_use_tmux(Some(use_tmux)), false),
    None => resolve_effective_default_channel(&overrides, mode.cli, &*resolve_plugin(mode.cli)),   // ← was: Channel::Json
});
```

#### Decision 3: `create_normal_session`'s mode validation moves ahead of `defaulted_channel` (M1 fix); draft-start paths get the same treatment (M3 fix)

- **Decision:** move the existing `r#type == Agent && mode_id.is_none()` check and the `resolve_mode_id`/canonicalization block (currently `sessions.rs:681-694`, *after* `defaulted_channel` at `:660-668`) to run **before** `defaulted_channel`. `defaulted_channel` then resolves off the already-canonicalized `mode_id` via `modes::resolve_mode` (Decision 2's helper — one `load_modes()` for both this and the later plugin lookup) **and** `resolve_effective_default_channel` fed by `load_default_channel_overrides()` (Decision 2/8's helpers — override-aware, not a raw plugin call). `SessionType::Terminal` keeps its unconditional `Channel::Tmux`, untouched by any of this. Apply the identical fix at the two draft-start sites (`:1881`, `:2025`) — both `start_new_worktree` and its existing-worktree/tab sibling already receive a **resolved** `mode_id: &str` *parameter* (not `draft_config.mode_id`, which is the still-`Option<String>` pre-resolution field — round-2 m1 caught this exact mix-up): `draft_config.channel.unwrap_or(Channel::Json)` → `unwrap_or_else(|| resolve_mode(mode_id).map(|m| resolve_effective_default_channel(&load_default_channel_overrides(), m.cli, &*resolve_plugin(m.cli))).unwrap_or(Channel::Json))`, so `POST /sessions/:id/start` honours Requirement 3 too. Leave `:228`/`:4616` untouched (placeholder values for an in-flight `drafting` record, not a resolved default) — add a one-line comment there saying so, to stop a future pass from "fixing" them.
- **Rationale:** the reorder removes M1's reachable wrong-default case (a mode given by *name* previously missed the id-only `find_mode` used for defaulting, silently falling back to `Json` even for an `agy` mode); moving validation earlier is safe because none of the channel-defaulting code can itself fail — only the ordering changes, not the set of possible errors. M3 exists because the plan's Requirement 3 explicitly promises this for "an agent session with no explicit/inherited channel", and `/start` is exactly such a path that the first draft missed.
- **Where:** `rust/vst-routes/src/sessions.rs:660-668,681-694` (reorder + resolve via helper), `:1881,2025` (draft-start fix), `:228,4616` (explicitly left alone, comment only).

#### Decision 4: CLI `channel` option becomes `Option<String>`, three-state, not two

- **Decision:** `AgentCreateOptions.channel: Option<String>` (default `None`), same for `WorktreeCreateOptions`. `run_agent_create`/`run_worktree_create` match: `None` ⇒ send `channel: None`; `Some("tmux")`/`Some("json")` ⇒ validate + send `Some(Channel::...)`; `Some(other)` ⇒ existing error.
- **Rationale:** the CLI must distinguish "user didn't pass `--channel`" (send `None`, let daemon resolve) from "user explicitly typed tmux/json" (send that literal `Some`) — a `String` with a baked-in default can't represent that.
- **Where:** `rust/vst-cli/src/commands/agent/create.rs:9-33` (struct + `Default`), `:120-131` (validation + body construction); same shape in `rust/vst-cli/src/commands/worktree/create.rs:16-42,133-145`.

```rust
// AgentCreateOptions / WorktreeCreateOptions
pub channel: Option<String>,   // was: String, default "tmux".to_string()
// Default::default(): channel: None,

// run_agent_create / run_worktree_create
let channel = match opts.channel.as_deref() {
    None => None,
    Some("tmux") => Some(Channel::Tmux),
    Some("json") => Some(Channel::Json),
    Some(other) => return Err((format!("--channel must be 'tmux' or 'json' (got '{other}')"), 1)),
};
// ...
let body = CreateSessionBody { /* ... */ channel, /* was: channel: Some(channel) */ };
```

#### Decision 5: DraftComposer default-follows-mode via a *persisted* explicit flag, not an inferred one (B1 fix), resolved via server data, not a CLI-id literal (B2 fix)

- **Decision:**
  - Add `channelExplicit?: boolean` to `DraftConfig` in **both** `web-ui/src/api/types.ts:203-207` and `rust/vst-types/src/domain.rs:491-494` — the bit that means "the user (or a prior explicit save) chose this channel on purpose", independent of whether `channel` itself is present.
  - `channelTouchedRef` initializes from `initialConfig?.channelExplicit === true` (not `initialConfig?.channel != null`).
  - Add `defaultChannel: Channel` to `SupportedCli` (`rust/vst-types/src/rest/modes.rs:11-20`), filled via `resolve_effective_default_channel(&overrides, cli, &*plugin)` (Decision 8 — override-aware, not a raw `plugin.default_channel()` call) in `list_supported_clis` (`rust/vst-routes/src/modes.rs:303-341`); wire position matches where `supports_json` is already filled.
  - The mode-follow effect (keyed on `selectedCli`/`clis`) reads `clis.find(c => c.id === selectedCli)?.defaultChannel ?? "json"` — **no `"agy"` string anywhere in `DraftComposer.tsx`.**
  - Both radio `onChange` handlers (`:1062,1071`) set `channelTouchedRef.current = true` **and** `currentConfig`'s serialized `channelExplicit: true`; the mode-follow effect itself must never set `channelExplicit`.
  - `LeftSidebar.tsx:1128` and `projectDraft.ts:35` keep their scaffold `channel: "json"` (harmless now — it's overridden the moment `channelExplicit` is absent) but do **not** set `channelExplicit`, so the mode-follow effect fires for both entry points as intended.
- **Rationale:** B1 — inferring "touched" from "channel is present" was always going to be `true` for these two draft-seeding call sites (Research § Round-1 review), so the bit must be a real, explicitly-set flag, not derived from a field that's populated for unrelated reasons (a scaffold default, an autosave echo). B2 — checking `selectedCli === "agy"` directly violates `AGENTS.md` § Agent plugin's own invariant ("never branch on CLI id outside the plugin"); this plan's own stated success criterion is that calling code never inspects `CliId` again, so the UI must consume the plugin's answer over the wire, the same way it already consumes `supportsJson`.
- **Where:** `web-ui/src/components/draft/DraftComposer.tsx:165-273,1062,1071`; `web-ui/src/api/types.ts:203-207,455-480`; `rust/vst-types/src/domain.rs:491-494`; `rust/vst-types/src/rest/modes.rs:11-20`; `rust/vst-routes/src/modes.rs:303-341`; `web-ui/src/api/mock.ts:1255+` (4 `SupportedCli` fixtures need `defaultChannel`).

#### Decision 6: subagent channel inheritance is scoped to "same CLI", not "any CLI" (B3 fix)

- **Decision:** in `create_normal_session`'s inheritance step (`sessions.rs:638-655`), a subagent inherits the parent's channel only when the child's resolved mode has the **same `cli`** as the parent's resolved mode (this always holds when `--mode` is omitted, since an omitted mode inherits the parent's mode outright — `mode_id.is_none()` branch at `:645-647`). When an explicit `--mode` names a mode on a **different** CLI, `inherited_channel` is not used — the child falls through to that CLI's own effective default (`resolve_effective_default_channel`, Decision 8 — override-aware), matching `agent-subagent-richchat.md:72-75`'s existing guidance that an `agy` child should default to `Tmux` even from a `Json` (Rich Chat) parent, unless a user override says otherwise.
- **Rationale:** B3 — CLI-side inheritance was previously unreachable (the CLI always sent an explicit channel), so this plan is the first time it actually fires; without the same-CLI guard, a Rich-Chat parent spawning an explicit `--mode=<agy-mode>` child with no `--channel` would get `Json`, silently defeating the entire point of Requirement 2 for that child. Same-CLI-only inheritance keeps both promises true: "subagents normally inherit their parent's channel" (unchanged mode → same CLI → inherits) and "agy defaults to tmux" (different CLI → plugin default, never inherited).
- **Where:** `rust/vst-routes/src/sessions.rs:638-668` — add the parent-mode's `cli` to the lookup already done for `inherited_channel`, using the *actual* existing destructuring at this call site (round-2 m1: the prior snippet invented a nonexistent `source_mode`/`source.channel`; the real code matches `SessionContext::Worktree { session, .. } | SessionContext::Direct { session, .. }` at `:642-651`, and the parent's `channel` comes from that `session.channel`, not from a bare `source`).

```rust
// sessions.rs — inheritance is same-CLI-scoped, not unconditional
if let Some(source_agent_id) = &data.source_agent_id {
    if let Some(source) = find_session_context(&self.store, source_agent_id).await {
        match &source {
            SessionContext::Worktree { session, .. } | SessionContext::Direct { session, .. } => {
                if mode_id.is_none() {
                    mode_id = session.mode_id.clone();   // unchanged: omitted --mode inherits parent's mode
                }
                if data.channel.is_none() {
                    // Parent's CLI, resolved fresh (not cached from data.channel's own
                    // presence) — if the parent's mode was since deleted, resolve_mode
                    // returns None and we deliberately do NOT inherit (fall through to
                    // this child's own effective default) rather than guess.
                    let parent_cli = session.mode_id.as_deref().and_then(resolve_mode).map(|m| m.cli);
                    let child_cli = mode_id.as_deref().and_then(resolve_mode).map(|m| m.cli);
                    if child_cli.is_some() && child_cli == parent_cli {
                        inherited_channel = session.channel;   // ← unchanged from today's (newly-reachable) behaviour
                    }
                    // else: no inheritance — falls through to this child's own effective default
                }
            }
            SessionContext::Global { .. } => {}
        }
    }
}
```

#### Decision 7: `default_channel() == Json` requires `supports_json() == true` — enforced by a workspace-wide test AND at settings-write time (M4 fix, extended by Decision 8)

- **Decision:** add a unit test in `rust/vst-agents/src/registry.rs` iterating every entry the registry knows about (`SUPPORTED_CLIS`) asserting `!(p.default_channel() == Channel::Json) || p.supports_json()`; add a one-line rule to the trait method's doc comment on `plugin.rs:258` stating the same invariant. Decision 8 reuses this exact invariant as a `PATCH /settings` validation rule: an override of `Json` for a CLI whose plugin doesn't `supports_json()` is rejected the same way an absolute-path violation is for `skillPaths`.
- **Rationale:** a plugin that defaults to `Json` but doesn't support it would 400 on every default-path create — worse than today, and easy to introduce by mistake for a 5th CLI since nothing currently connects these two methods. Once a *user* can also override the default to `Json`, the same mistake becomes reachable at runtime, not just at plugin-authoring time — hence gating both.
- **Where:** `rust/vst-agents/src/registry.rs` (new test), `rust/vst-agents/src/plugin.rs:258` (doc comment), `rust/vst-routes/src/settings.rs` (write-time gate, Decision 8).

#### Decision 8: per-CLI default-**channel** override — a free daemon-side function, not struct-field DI (round-2 M1); per-key write, not whole-map replace (round-2 B2); `CliId` must derive `Ord` (round-2 B1)

- **Decision:**
  - **`CliId` gains `PartialOrd, Ord`** in its derive list (`rust/vst-types/src/domain.rs:41`) — required for it to be a `BTreeMap` key at all; without this the plan does not compile (round-2 B1). `BTreeMap` (not `HashMap`) is kept for deterministic key order in `config.json`.
  - **Storage — two separate fields, not one:** `Settings.default_channel_by_cli: Option<BTreeMap<CliId, Channel>>` (read side, `GET /settings`) **and** `PatchSettingsBody.default_channel_by_cli: Option<BTreeMap<CliId, Option<Channel>>>` (write side — `rust/vst-types/src/rest/settings.rs`). These are genuinely different structs in this codebase (`skillPaths`/`themeId`/etc. already follow this split); round-2 B2 caught that the first draft added the field only to `Settings`, which means nothing could ever write it. The write side's value being `Option<Channel>` (not bare `Channel`) is what lets a `null` entry **clear** that one CLI's override.
  - **Write path — per-key merge, in the existing raw-JSON RMW inside `patch_settings`** (`rust/vst-routes/src/settings.rs`, same `raw["markdownStyle"] = ...` pattern already used for `MarkdownStyle` at `:882-883`): for each `(cli, value)` in the request body, `Some(ch)` sets `raw["defaultChannelByCli"][cli] = ch`, `None` removes that one key — never `raw["defaultChannelByCli"] = body_value` wholesale. This is what makes "change agy's override, leave claude's alone" and "two quick toggles on different CLI rows" both safe (round-2 B2's race).
  - **Validation, extracted as a pure, independently-testable function** (round-2 M4 — the previous draft's write-time gate had no seam to actually unit-test it): `fn validate_default_channel_overrides(entries: &BTreeMap<CliId, Channel>, resolver: fn(CliId) -> Box<dyn AgentPlugin>) -> Result<(), SettingsRouteError>` — rejects `Channel::Json` for any `cli` whose `resolver(cli).supports_json()` is `false`; rejects `Channel::Pty` unconditionally (the override's valid range is `{Tmux, Json}` only, never all of `Channel` — round-2 M4 point 3). Called from `patch_settings` with the real `resolve_plugin`; unit-tested with a stub resolver whose plugin returns `supports_json() == false` (no production CLI does today, so the test needs its own stub, not a real `CliId`).
  - **Resolution stays a free, pure function** — `resolve_effective_default_channel(overrides: &BTreeMap<CliId, Channel>, cli: CliId, plugin: &dyn AgentPlugin) -> Channel`, made **total** (Decision 2's updated snippet): even a *persisted* `Json` override for a CLI that later loses `supports_json` (a plugin capability change, or a hand-edited `config.json`) falls back to the plugin default instead of making every default-path create 400 — write-time validation reduces how *often* a bad value gets in, it doesn't replace the read-time total-ness.
  - **No struct-field DI.** The first draft added a `settings_routes: SettingsRoutes` field to `ModeRoutes`/`SessionRoutes`/`WorktreeRoutes` plus a `server.rs` construction-order fix. Round-2 M1 found this breaks ~25 existing call sites for no real benefit: `SessionRoutes` has a **hand-written `Clone` impl** (not derived) that would need editing, plus 10 struct-literal test sites across `sessions_group_{a,b1,b2,c,d}.rs`; `ModeRoutes::new`/`WorktreeRoutes::new` have 10 + 4 more call sites across `modes_and_open.rs`/`oobe.rs`/`projects.rs`/`lsp_test.rs`/`worktrees.rs`. Instead: `load_default_channel_overrides() -> BTreeMap<CliId, Channel>` is a **free function** in `rust/vst-routes/src/settings.rs`, reading `config.json` directly via `vst_agents::home::home_dir()` — the exact same root-resolution convention `modes::load_modes()` already uses for `modes.json` (Decision 2's snippet). No `server.rs` change, no `Clone`-impl edit, no test-literal churn. Per-entry parsing (round-2 M3): iterate the raw JSON object and parse each `(key, value)` independently, skipping ones that don't parse — one unrecognized `CliId` string (a hand-edit typo, or a config written by a newer daemon with a since-removed CLI) must not silently drop every other CLI's override.
  - **Every consumer calls the same two functions** (`load_default_channel_overrides` then `resolve_effective_default_channel`), never `plugin.default_channel()` directly (Requirement 12): session/worktree create-time defaulting, draft-start (Decision 3), the same-CLI-inheritance fallback (Decision 6), `list_supported_clis` (Decision 5/B2), **and** `POST /projects/create`'s `startAgent` path (round-2 M2 — see the new fix below; this consumer was missed entirely in the prior draft).
  - **CLI needs no new flag.** A channel override changes what "the default" *is*; the CLI's existing optional `--channel` (Decision 4) is already the complete interface.
  - **UI is a thin caller, and shows which value is the plugin default** (round-2 m3 — the prior draft had no way to tell "this is the plugin default" from "this is an explicit override", so picking the same value as the default would still pin an override the user never meant to set, and there'd be no way to clear one): `SupportedCli` gains a second field, `defaultChannelOverridden: bool` (alongside the existing override-aware `defaultChannel`), so `CliDetectionPanel.tsx` (`variant="settings"` only) can label the plugin-default option "(default)" and show whether the current value is an override. Selecting the labeled-default option sends `null` for that key (clears it, per the write-path's per-key merge); any other selection sends the explicit `Channel`. `onChange` → `api.updateSettings({ defaultChannelByCli: { [cli.id]: valueOrNull } })` (single-key body — the per-key merge write path makes this safe without a prior `Settings` fetch) → refetch `getSupportedClis()` (mirrors `createBundle`'s existing refetch at `:48-52`).
  - **Cross-tab/already-open-draft staleness is accepted, not fixed** (round-2 m3): `DraftComposer` fetches `clis` once on mount, so a change made in another tab doesn't reach an already-open draft until remount — acceptable because the daemon re-resolves the effective default at *create* time regardless of what the draft's stale copy displayed, for any draft that never set an explicit channel.
- **Rationale:** the entire plan already establishes "resolve the default channel through one place, never call the plugin ad hoc" (Requirement 1-3's whole point); a user override is a second input to that same resolution, not a parallel mechanism, and the resolution logic living in a free function (not behind new struct-field DI) keeps the blast radius of this addition to the settings/modes modules instead of every route struct's constructor.
- **Where:** `rust/vst-types/src/domain.rs:41` (`CliId` derive), `rust/vst-types/src/rest/settings.rs` (both `Settings`/`PatchSettingsBody` fields), `rust/vst-routes/src/settings.rs` (`load_default_channel_overrides`, `validate_default_channel_overrides`, per-key merge in `patch_settings`), `rust/vst-routes/src/modes.rs` (`resolve_effective_default_channel`, `list_supported_clis` update), `rust/vst-routes/src/sessions.rs`/`worktrees.rs`/`projects.rs` (call-site updates, no new fields), `web-ui/src/components/agent/CliDetectionPanel.tsx` (selector + "(default)" labeling), `web-ui/src/components/settings/SettingsPanel.tsx:34` (label rename, same edit as Requirement 9).

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Does reordering `create_worktree`'s mode resolution before channel resolution change any observable error ordering?** | Closed (round-1 m6): `channel` is a typed `Channel` enum in the wire body already, so a daemon-side "invalid channel" error isn't reachable — only the CLI validates the raw string pre-flight. Reordering only changes which check runs first when the mode itself is *also* invalid, and "mode not found" was always the correct error to surface first. Add a regression test (2.T7) confirming the message/shape is unchanged; add a second regression test for the legacy `use_tmux: Some(false)`-with-no-`channel` path (`pty`), which nothing currently covers and which the reorder touches. |
| 2 | **Does an existing persisted worktree/session (created before this change, channel already stored) need any backward-compat handling?** | No — `default_channel()` only fires at *creation* time when channel is unresolved; already-persisted records keep their stored `channel` field untouched, read via the existing explicit-channel path. Not a migration. |
| 3 | **Should `DraftComposer`'s Tier-2 (global, no project yet) entry point respect the mode default too, or does it never have a mode picked early enough to matter?** | Same component, same effect — Tier 2 also picks `modeId` via the same `modes`/`selectedCli` state (line 162-264 is shared across tiers), so Decision 5's effect covers both entry points with no extra branching. |
| 4 | **`use_tmux` legacy field interplay:** `create_worktree`/`create_normal_session` still accept a legacy `use_tmux: Option<bool>` alongside `channel`. | Out of scope to remove; Decision 2/3 preserve the existing `Some(use_tmux) => resolve_channel(...)` branch verbatim — plugin default only applies when *both* `channel` and `use_tmux` are absent, matching today's precedence. |
| 5 | **Stored drafts with `channel` already set but no `channelExplicit` (every draft saved before this plan ships) — does B1's fix silently "flip" them?** | Yes, and that's intended: a draft saved on an `agy` mode under the old always-`"json"` scaffold gets switched to Terminal on reopen, once `channelExplicit` is absent. This is the correct behaviour (the old value was never a real user choice), but call it out in the commit message/changelog, not just in this table, since it's a visible one-time change for anyone with an open draft at deploy time. |
| 6 | **Old CLI binary talking to a new daemon, or vice versa (channel defaulting).** | Old CLI → new daemon: old CLI still always sends an explicit `channel`, so behaviour is unchanged for that user. New CLI → old daemon: an omitted `channel` makes the old daemon default everything (including `agy`) to `Json` — harmless (agy supports json) but produces the "wrong" default until both sides are upgraded. Not blocking; `~/.cargo/bin` install skew is a pre-existing general risk, not new to this plan. |
| 7 | ~~`server.rs` construction-order fix~~ | **Closed by round-2 M1** — Decision 8 no longer touches `server.rs` at all; `load_default_channel_overrides()` is a free function, not struct-field DI, so there is no construction-order dependency to introduce or verify. |
| 8 | **Can a stale/removed CLI still have a `defaultChannelByCli` entry after, say, a hypothetical CLI removal?** | Not reachable today — `CliId` is a fixed compile-time enum (`SUPPORTED_CLIS`), not a dynamic value, so an override can only ever be keyed by a CLI that currently exists in the binary. If a CLI is ever removed in a future release, its stale override entry in an old `config.json` is simply never read (the enum variant is gone) — per-entry parsing (round-2 M3, Decision 8) means this is a *skipped* entry, not a corrupting one either way. |
| 9 | **Does overriding a CLI's default to `Tmux` change anything about `agent-subagent-richchat.md`'s "prefer `--channel=tmux` for agy" guidance?** | No — that guidance is about an agent choosing to *pass* `--channel=tmux` explicitly for a subagent; it's independent of what the *daemon's own default* resolves to. If a user overrides agy's default to `Json`, an agent following that doc's advice still explicitly overrides it back to `Tmux` per the doc, which is exactly the point of an explicit flag beating any default (override or plugin). |
| 10 | **`patch_settings` writes `config.json` with a plain truncate-then-write (`tokio::fs::write`, `settings.rs:305`), with no lock on the reader side — round-2 M5.** | A request that reads settings (any session/worktree create, or `GET /supported-clis`) racing a concurrent `PATCH /settings` write (from *any* settings field, not just this one) can observe a momentarily-empty or partially-written `config.json`, which `load_default_channel_overrides()`'s `unwrap_or_default()` silently treats as "no overrides" for that one request. Accepted, not fixed, in this plan's scope: the window is narrow (a single `tokio::fs::write` call), the consequence is "used the plugin default instead of the override for one request," and making the write atomic (`write` to a `.tmp` path then `rename`) is a pre-existing gap across every settings field, not something specific to this feature — worth its own follow-up, not bundled here. |
| 11 | **Uncached `load_default_channel_overrides()`/`resolve_mode()` on every session/worktree create — is a disk read per request a real latency concern?** | No (round-2 M5) — these routes already call the equally-uncached `load_modes()` two to three times per request, and `list_supported_clis` already does a PATH probe per CLI; one more small synchronous JSON read is noise. No caching layer is being added, and none should be — a cache would reintroduce exactly the "stale value after a PATCH" lag 6.T3 is designed to prove doesn't happen. |

---

## Implementation Phases

---

### Phase 1 — Trait + plugin implementations (Rust core)

- [x] **1.1** Add `fn default_channel(&self) -> Channel;` to `AgentPlugin` trait — `rust/vst-agents/src/plugin.rs:258` (after `compose_launch_prompt`), import `vst_types::domain::Channel` if not already in scope.
- [x] **1.2** Implement `default_channel(&self) -> Channel { Channel::Json }` in `rust/vst-agents/src/claude.rs` (in the existing `impl AgentPlugin for ClaudePlugin` block, `:205+`).
- [x] **1.3** Same in `rust/vst-agents/src/cursor.rs` (`:324+`).
- [x] **1.4** Same in `rust/vst-agents/src/opencode.rs` (`:312+`).
- [x] **1.5** Implement `default_channel(&self) -> Channel { Channel::Tmux }` in `rust/vst-agents/src/agy.rs` (`:338+`).
- [x] **1.6** Add `fn default_channel(&self) -> Channel { Channel::Json }` to the `stub_plugin_base!()` macro — `rust/vst-routes/src/modes.rs:820-849` (covers `FailingModelsPlugin` + `PartialModelsPlugin`).
- [x] **1.7** Add `default_channel` to `NoopPlugin` — `rust/vst-agents/src/json_agent_session/mod.rs:1069+` (return `Channel::Json`; import `Channel` in the test module if needed).
- [x] **1.8** Add `default_channel` to `MockTurnPlugin` and `HangingTurnPlugin` — `rust/vst-agents/tests/json_agent_session_queue.rs:68+,228+` (return `Channel::Json` for both; import `vst_types::domain::Channel`).

**Verify phase 1:**
- [x] **1.T1** Unit — `cargo build -p vst-agents -p vst-routes --tests` compiles clean (confirms every `AgentPlugin` impl in the workspace, including test doubles, implements `default_channel`).
- [x] **1.T2** Unit — `ClaudePlugin::default_channel()==Channel::Json`, `CursorPlugin::default_channel()==Channel::Json`, `OpencodePlugin::default_channel()==Channel::Json`, `AgyPlugin::default_channel()==Channel::Tmux` (one assertion each, colocated with each plugin's existing test module).

---

### Phase 2 — Daemon route resolution

- [x] **2.0a** `rust/vst-types/src/domain.rs:41` — add `PartialOrd, Ord` to `CliId`'s derive list (round-2 B1 — required for `BTreeMap<CliId, _>` to compile at all).
- [x] **2.0b** `rust/vst-types/src/rest/settings.rs` — add `pub default_channel_by_cli: Option<BTreeMap<CliId, Channel>>` to `Settings` (**read side only** — round-2 B3: Phase 2's own defaulting logic reads this shape via `load_default_channel_overrides()`, so it must exist from Phase 2 on). The **write side** (`PatchSettingsBody`'s field, letting a user actually set an override) is added in Phase 6 (6.1) — nothing in Phase 2 writes settings, so it can wait; Phase 2 only ever reads an override that Phase 6 makes settable.
- [x] **2.1** `rust/vst-routes/src/modes.rs` — add `pub fn resolve_mode(input: &str) -> Option<Mode>` (Decision 2), a **two-pass** (id-over-the-whole-list, then name) lookup matching `resolve_mode_id`'s exact semantics — round-2 m1 caught that a naive single-pass `id == input || name == input` can resolve a different mode than `resolve_mode_id` does when one mode's name collides with another's id.
- [x] **2.1b** `rust/vst-routes/src/settings.rs` — add `pub fn load_default_channel_overrides() -> BTreeMap<CliId, Channel>` (Decision 8) — a **free function**, not a struct field/DI (round-2 M1 rejected the struct-field design: it would touch ~25 existing constructor/`Clone`-impl/test-literal sites across 8+ files for no benefit). Reads `config.json` directly via `vst_agents::home::home_dir()` — the same root-resolution convention `modes::load_modes()` already uses — with **per-entry** parsing (round-2 M3: one unrecognized `CliId` key must not drop every other override).
- [x] **2.1c** `rust/vst-routes/src/modes.rs` — add `pub fn resolve_effective_default_channel(overrides: &BTreeMap<CliId, Channel>, cli: CliId, plugin: &dyn AgentPlugin) -> Channel` (Decision 8) — pure, **total**: an override of `Json` for a CLI whose plugin doesn't (or no longer) `supports_json()` falls back to the plugin's own default rather than propagating a value that would 400 every create (round-2 M4).
- [x] **2.2** `rust/vst-routes/src/worktrees.rs:507-540` — reorder so mode resolution (via `resolve_mode`) runs before the `channel` computation; fetch `let overrides = load_default_channel_overrides();` once; `None` arm of the `use_tmux` match becomes `resolve_effective_default_channel(&overrides, mode.cli, &*resolve_plugin(mode.cli))`, no `.expect()` (Decision 2).
- [x] **2.3** `rust/vst-routes/src/sessions.rs:660-694` (`create_normal_session`) — move the `r#type == Agent && mode_id.is_none()` check and mode canonicalization (currently after `defaulted_channel`) to run *before* it; `defaulted_channel` resolves via `resolve_mode(&mode_id)` + `resolve_effective_default_channel(&overrides, ...)` for `SessionType::Agent`, keeps `Channel::Tmux` unconditionally for `SessionType::Terminal` (Decision 3, fixes M1).
- [x] **2.4** `rust/vst-routes/src/sessions.rs:638-655` (inheritance step) — same-CLI guard from Decision 6, using the actual `SessionContext::Worktree { session, .. } | SessionContext::Direct { session, .. }` destructuring already at this call site (round-2 m1 fix); the non-inherited fallback goes through `resolve_effective_default_channel` too, not a raw plugin call; if the parent's own mode has since been deleted (`resolve_mode` on it returns `None`), do **not** inherit — fall through to the child's own effective default.
- [x] **2.5** `rust/vst-routes/src/sessions.rs:1881,2025` (draft-start paths, `start_new_worktree` and its sibling) — replace `draft_config.channel.unwrap_or(Channel::Json)` with the override-aware fallback via `resolve_mode(mode_id)` (the function's **existing resolved `mode_id: &str` parameter**, not `draft_config.mode_id` — round-2 m1: those are different things, the latter is the pre-resolution `Option<String>`) + `resolve_effective_default_channel` (Decision 3, fixes M3); add a one-line comment at `:228,4616` explaining those two are intentionally left as placeholder values, not a resolved default.
- [x] **2.6** `rust/vst-agents/src/registry.rs` — add the `default_channel()==Json ⇒ supports_json()` invariant test (Decision 7, fixes M4); add the rule as a one-line doc comment on `plugin.rs:258`.
- [x] **2.7** Confirm `resolve_plugin` is already imported in both route files (Research confirms `sessions.rs:63`, `worktrees.rs:37`); import `resolve_mode`/`resolve_effective_default_channel`/`load_default_channel_overrides` where newly used.
- [x] **2.8** `rust/vst-routes/src/projects.rs:872,1004` (`create_new_project`'s worktree and direct arms) — round-2 M2: both currently hardcode `channel: Some(Channel::Tmux)` for the `startAgent` path (reachable via `vst project create --start-agent` and the web-ui). Route both through `resolve_mode(&resolved_mode_id)` + `resolve_effective_default_channel(&load_default_channel_overrides(), mode.cli, &*resolve_plugin(mode.cli))`, deriving `use_tmux` from the result — this was a real missed consumer of Requirement 12's "every consumer" claim, not an edge case.

**Verify phase 2:**
- [x] **2.T1** Integration — `create_normal_session`: agent session, mode bound to `agy` **by id**, no `channel`/`use_tmux` → `channel == Some(Channel::Tmux)`.
- [x] **2.T1b** Integration — same, mode given **by name** (not id) — regression for M1; must also resolve to `Tmux`, not fall through to `Json`.
- [x] **2.T2** Integration — `create_normal_session`: agent session, mode bound to `claude`, no `channel`/`use_tmux` → `channel == Some(Channel::Json)`.
- [x] **2.T3** Integration — `create_normal_session`: terminal-type session (no mode at all) → `channel == Some(Channel::Tmux)` regardless of any mode context.
- [x] **2.T4** Integration — `create_normal_session`: CLI-shaped subagent request (`source_agent_id` set, `channel: None`, `mode_id: None` i.e. inherited mode) whose parent is on `Channel::Json` → inherits `Channel::Json` (same-CLI case, Decision 6).
- [x] **2.T4b** Integration — same parent (`Channel::Json`, e.g. `claude`), but child request has an explicit `--mode=<agy-mode>` (different CLI) and `channel: None` → child gets `Channel::Tmux` (agy's own plugin default), **not** the inherited `Json` — this is the case B3's fix specifically protects.
- [x] **2.T4c** Integration — same as 2.T4, but the parent's own mode has since been deleted from `modes.json` → child does **not** inherit; falls through to its own effective default (m1's parent-mode-deleted decision).
- [x] **2.T5** Integration — `create_worktree`: `mode_id` bound to `agy`, no `channel`/`use_tmux` → created worktree's main session channel is `Tmux`.
- [x] **2.T6** Integration — `create_worktree`: `mode_id` bound to `cursor`, no `channel`/`use_tmux` → `Json`.
- [x] **2.T7** Regression — `create_worktree`: invalid `mode_id` still returns the existing `Validation` error, message/shape unchanged (now surfaces before channel logic runs, per Decision 2).
- [x] **2.T8** Regression — `create_worktree`/`create_normal_session`: valid mode, `use_tmux: Some(false)`, no `channel` → still yields `pty` (legacy branch the reorder touches; previously uncovered — Risk #1).
- [x] **2.T9** Integration — `POST /sessions/:id/start` on a draft whose `draftConfig` has no `channel` and an `agy` `mode_id` → started session's channel is `Tmux` (M3 fix).
- [x] **2.T10** Unit — `rust/vst-agents/src/registry.rs`: every `SUPPORTED_CLIS` plugin satisfies `!(default_channel()==Json) || supports_json()` (M4 fix).
- [x] **2.T11** Unit — `resolve_effective_default_channel`: empty overrides → returns `plugin.default_channel()`; override present for `cli` → returns the override, ignoring the plugin; override present for a *different* `cli` → still returns the plugin default for the queried `cli` (map lookup is per-key, not global); override of `Json` for a **stub** plugin with `supports_json() == false` → falls back to that plugin's own default, does not return `Json` (the total-ness fix, round-2 M4).
- [x] **2.T12** Integration — `create_normal_session`/`create_worktree`, with `config.json`'s `defaultChannelByCli` containing `{ "agy": "json" }` (written directly to the test's `home_dir()`-redirected `config.json`, via `with_home()` — same tempdir `modes.json` already lives in, per round-2 M1's fix to the two-tempdir hazard): an `agy`-mode session/worktree with no explicit `channel` → `Channel::Json` (override wins over the plugin's own `Tmux`).
- [x] **2.T13** Unit — `load_default_channel_overrides()`: a `config.json` with one valid entry and one unparseable/unknown-`CliId` entry → the valid entry still loads (round-2 M3's per-entry-parsing regression).
- [x] **2.T14** Integration — `create_new_project` with `startAgent` set, a `claude` mode, no override → created agent session's channel is `Json`, not the previously-hardcoded `Tmux` (M2 fix).
- [x] **2.T15** Note on test placement (round-1 m5) — put 2.T1-2.T4c, 2.T12-2.T13 in `rust/vst-routes/tests/sessions_group_b2.rs` (already seeds modes per its existing pattern) and 2.T5-2.T8 in `rust/vst-routes/tests/worktrees.rs`; 2.T14 in `rust/vst-routes/tests/projects.rs`; seed one `claude`, one `cursor`, and one `agy` mode in each file's fixtures. No `SettingsRoutes` test double is needed anywhere (round-2 M1) — `load_default_channel_overrides()` is a free function redirected by the same `with_home()` guard the modes fixtures already use.

---

### Phase 3 — CLI option parsing + payload

- [x] **3.1** `rust/vst-cli/src/commands/agent/create.rs:9-33` — change `AgentCreateOptions.channel` to `Option<String>`; `Default` sets it to `None` (was `"tmux".to_string()`).
- [x] **3.1b** `:79-86` — parser arm that currently does `opts.channel = <String>` wraps the assigned value in `Some(...)`.
- [x] **3.2** `:120-131` (`run_agent_create`) — replace the unconditional match with the three-way match from Decision 4; body sends `channel` (the `Option<Channel>`) directly, not `Some(channel)`.
- [x] **3.3** `rust/vst-cli/src/commands/worktree/create.rs:16-42` — same struct/`Default` change.
- [x] **3.3b** `:93-100` — same `Some(...)`-wrap on the parser arm.
- [x] **3.4** `:133-145` (`run_worktree_create`) — same three-way match + body change.
- [x] **3.5** Update doc comment `worktree_project_file_daemon_contract.rs:7` ("`--channel` (`tmux`\|`json`, default `tmux`)") to describe the new default-is-daemon-resolved behavior — update in the same commit as its test file (3.T1) since it's a comment, not code, but lives right above the tests being changed.

**Verify phase 3:**
- [x] **3.T1** Regression — `rust/vst-cli/tests/worktree_project_file_daemon_contract.rs:68,98`: update assertions from `opts.channel == "tmux"`/`"json"` (String) to `opts.channel == None` (default, no `--channel` passed, line 68) and `opts.channel == Some("json".to_string())` (explicit `--channel=json` case, line 98) — fix the typo from round 1 (was written as `Option<"tmux".into())`, invalid syntax; the corrected assertions are as just stated).
- [x] **3.T2** Regression — `rust/vst-cli/tests/session_mode_contract.rs:112-120`: update the `--channel json` parse-test assertion the same way (`Some("json".to_string())`).
- [x] **3.T3** Regression — `session_mode_contract.rs:150-162` (`test_agent_create_invalid_channel_rejected`): change the fixture's `channel: "pty".to_string()` to `channel: Some("pty".to_string())`; assertion on the rejection message is unchanged.
- [x] **3.T4** Regression — `session_mode_contract.rs:605,619` (two option-struct literals used elsewhere in the test file): update `channel: "json".to_string()` / `"tmux".to_string()` to `Some("json".to_string())` / `Some("tmux".to_string())`; replace the `:619` literal (`"tmux"`) with `None` instead, so the default-resolution path is exercised end-to-end against the mock too (round-1 m4).
- [x] **3.T5** New — add a parse test asserting `parse_agent_create_options([...])` with no `--channel` flag yields `opts.channel == None`; same for `parse_worktree_create_options`.
- [x] **3.T6** New — a **body-capturing** mock (round-1 m3: the existing mocks at `session_mode_contract.rs:374-454`/`top_level_commands_contract.rs:576-670` only stage *response* bodies, they never inspect the *request*; needs an `Arc<Mutex<Option<serde_json::Value>>>` captured inside the axum handler's `POST /api/sessions`/`POST /api/worktrees` route) asserting: (a) omitting `--channel` sends a body where the `channel` key is **absent** (`CreateSessionBody`/`CreateWorktreeBody` are `#[skip_serializing_none]`, per `vst-types/src/rest/sessions.rs:77`/`rest/worktrees.rs:11` — assert absence, not `null`); (b) explicit `--channel=tmux` still sends `"channel":"tmux"` (regression guard against the override path silently degrading to `None`). Mount the mock under `/api/...` (`AGENTS.md` § CLI). Put the `run_agent_create` case in `session_mode_contract.rs` (already has a `POST /api/sessions` mock at `:404-424` to extend) and the `run_worktree_create` case in `worktree_project_file_daemon_contract.rs` (round-1 m3 flagged the plan's original `top_level_commands_contract.rs` assignment for the worktree case as backwards — that file has no `run_worktree_create` mock today).

---

### Phase 4 — Web UI default-follows-mode (B1 + B2 fix)

- [x] **4.0** `rust/vst-types/src/rest/modes.rs:11-20` — add `pub default_channel: Channel` **and** `pub default_channel_overridden: bool` to `SupportedCli`; `rust/vst-routes/src/modes.rs:303-341` (`list_supported_clis`) fills both via `load_default_channel_overrides()` (Phase 2's free function — no struct field needed) + `resolve_effective_default_channel(&overrides, cli, &*plugin)`, same spot `supports_json` is filled. `default_channel_overridden = overrides.contains_key(&cli)` — this is what lets the Settings UI (Phase 6) label the plugin-default option distinctly from an explicit override (round-2 m3).
- [x] **4.0b** `web-ui/src/api/types.ts:455-480` — add `defaultChannel: Channel` to the `SupportedCli` interface; `web-ui/src/api/mock.ts:1255+` — add `defaultChannel` to all 4 fixture entries (`"json"` for claude/cursor/opencode, `"tmux"` for agy).
- [x] **4.0c** Add `channelExplicit?: boolean` to `DraftConfig` in `web-ui/src/api/types.ts:203-207` **and** `rust/vst-types/src/domain.rs:491-494` (Decision 5 — the Rust side matters because `draft_config` round-trips through the typed struct on every autosave/reload).
- [x] **4.1** `web-ui/src/components/draft/DraftComposer.tsx` — add `channelTouchedRef = useRef(initialConfig?.channelExplicit === true)` near the other refs (`~206-214`) — **not** `initialConfig?.channel != null` (that was B1's bug).
- [x] **4.2** Add an effect after the `selectedCli`/`jsonSupported` computation (`~264-273`): if `!channelTouchedRef.current`, set `channel` from `clis.find(c => c.id === selectedCli)?.defaultChannel === "tmux" ? "terminal" : "json"` — no `"agy"` literal anywhere in this file (B2 fix).
- [x] **4.3** In both channel radio `onChange` handlers (`:1062,1071`, `name="draft-channel"`), set `channelTouchedRef.current = true` before calling `setChannel(...)`.
- [x] **4.4** `currentConfig`'s `useMemo` (`:276-281`) serializes `channelExplicit: channelTouchedRef.current` alongside `channel`, so the persisted draft carries the explicit-flag forward (autosave, Tier-2→Tier-1 upgrade at `:419-424`, and the unmount-flush at `:386-400` all reuse `currentConfig`, so this one change covers all three).
- [x] **4.5** Verify the existing `jsonSupported` effect (`:271-273`) still runs and still force-flips to `"terminal"` for a CLI that structurally can't do Rich Chat, independent of `channelTouchedRef`, and does **not** itself set `channelExplicit` (a hard capability override is not a user choice — confirm ordering/no conflict, no code change expected here beyond the fact it must not touch the ref).

**Verify phase 4:**
- [x] **4.T1** Integration — `DraftComposer` mounted with no `initialConfig`/no `channelExplicit`, mode list resolves to an `agy` mode first (or user selects one) → channel radio shows Terminal selected, `currentConfig.channel === "tmux"`.
- [x] **4.T2** Integration — same, mode is `claude`/`cursor`/`opencode` → Rich Chat selected, `currentConfig.channel === "json"`.
- [x] **4.T3** Integration — user manually selects Terminal, then changes `modeId` to a non-agy mode → channel stays Terminal (touched-ref respected, no clobber); `currentConfig.channelExplicit === true`.
- [x] **4.T4** Regression — restoring a draft with `initialConfig.channel === "tmux"`, `initialConfig.channelExplicit === true` (explicit prior choice) and mode `claude` → channel stays Terminal, not flipped to Rich Chat by the mode-follow effect.
- [x] **4.T5** Regression (B1's actual bug) — a draft created via `LeftSidebar.tsx:1128`'s `{ entryPoint: "worktree", worktreeChoice: "new", channel: "json" }` (no `channelExplicit`) with an `agy` mode selected → the mode-follow effect **does** fire and flips to Terminal, proving the scaffold's `channel: "json"` no longer blocks it.
- [x] **4.T6** Extend Tier 2 (`/draft/new`, entryPoint `global`) coverage in `DraftComposer.test.tsx:110-125` — agy mode with no explicit channel defaults to Terminal; `createWorktree`/`createDraftSession` payload's effective channel is `"tmux"`.
- [x] **4.T7** Integration — Tier 2 → Tier 1 upgrade (`:419-424`) preserves `channelExplicit` semantics — a Tier-2 draft where the user explicitly picked Terminal keeps that after upgrading to a project-scoped Tier-1 draft. (Verified by code inspection: every upgrade site spreads `currentConfig`, which carries `channelExplicit` from `channelTouchedRef`; combined with 4.T3/4.T4 which prove the touched-ref persists.)
- [x] **4.T8** Integration — switching from an agy mode (defaulted Terminal, untouched) to `claude` flips back to Rich Chat; switching to a CLI with `supportsJson: false` still forces Terminal via the `jsonSupported` effect, and that effect must not set `channelExplicit`.
- [x] **4.T9** Integration — on first load `modes`/`clis` are both `[]`, so `selectedCli` is `undefined` and the mode-follow effect's fallback (`?? "json"`) fires; assert no `updateDraft`/autosave call persists `channelExplicit: true` from this alone — only an actual radio click sets it.
- [x] **4.T10** Integration — with a settings override in place (`defaultChannelByCli: { agy: Json }`), `DraftComposer` picking an `agy` mode with no explicit channel defaults to Rich Chat, not Terminal — proves the UI's `defaultChannel` field (Phase 2's helper) reflects the override, not just the plugin's hardwired default.

---

### Phase 5 — Docs

- [x] **5.1** `skill/SKILL.md:103-105` (§5) — replace "Sessions default to a tmux-backed terminal channel" wording with: sessions default to Rich Chat (`json`) for `claude`/`cursor`/`opencode` modes, and Terminal (`tmux`) for `agy` modes; `--channel=json`/`--channel=tmux` override either way.
- [x] **5.2** `skill/SKILL.md` §6 (`vst agent create` for subagents, around `:115-132`) — same clarification where it currently implies a single universal default.
- [x] **5.3** `rust/vst-agents/assets/agent-system-prompt.md` — add a short note near the `vst agent create`/`vst worktree create` reference (`:89-114` region) documenting the per-CLI default and the two override flags.
- [x] **5.4** `rust/vst-agents/assets/agent-subagent-richchat.md:66-74` — reword "Case A does NOT inherit either — pass `--mode=<modeId> --channel=json` explicitly" and the `agy` exception note to reflect that the *daemon's own default* is now already correct per-CLI; explicit `--channel` is only needed to *override* that default, not to avoid an incorrectly-universal tmux default. Also add a line documenting that CLI subagent inheritance is now real (Requirement 3a / Decision 6): an omitted `--mode` and omitted `--channel` inherits the parent's channel; an explicit `--mode` on a different CLI does not.
- [x] **5.5** `docs/API-CONTRACT.md:24` — remove the documented-but-nonexistent worktree-create `--json` flag; document `--channel`/`--cli` instead (M5).
- [x] **5.6** `docs/API-CONTRACT.md:35` — replace "`--channel` selects `tmux` (default)" with the per-CLI wording (M5).
- [x] **5.7** `docs/SESSION-EXECUTION.md:5` — heading "tmux mode (default)" gains a line noting the per-CLI plugin default (M5).
- [x] **5.8** `AGENTS.md` § "Current plugin methods" table (Agent plugin section) — add a `default_channel()` row (`Required: yes`, `Purpose: default execution channel for this CLI`) — that table is this repo's own canonical plugin-method list (M5).
- [x] **5.9** Check `skill/SKILL.md:1`'s `vst-skill-version` marker — bump it if the project's convention is that a §5/§6 content change requires a version bump for installed copies to refresh (confirm convention before bumping; not all doc edits require it).
- [x] **5.10** `docs/API-CONTRACT.md:159-160` (round-2 m2) — document `defaultChannelByCli` on `GET`/`PATCH /settings` (merge/null-clears semantics, validation range `{tmux, json}`), and `defaultChannel`/`defaultChannelOverridden` wherever `GET /supported-clis`'s field list is documented.

**Verify phase 5:**
- [x] **5.T1** Manual — grep all doc files touched in this phase for the string `"default"` near `channel`/`tmux`/`json` and confirm no sentence still asserts a single universal default, and that the CLI-inheritance behaviour change is mentioned at least once in `skill/SKILL.md` and `agent-subagent-richchat.md`.

---

### Phase 6 — Settings rename + per-CLI default-**channel** override UI (Requirements 9-12, Decision 8)

> The daemon-side read/resolve helpers (`load_default_channel_overrides`, `resolve_effective_default_channel`) and the `Settings.default_channel_by_cli` read-side field were already built in Phase 2 (2.0b, 2.1b, 2.1c) — Phase 2 needed the *read* path correct from the start. This phase adds the **write** path (`PatchSettingsBody`'s field, validation, per-key merge) and the Settings UI.

- [x] **6.1** `rust/vst-types/src/rest/settings.rs` — add `pub default_channel_by_cli: Option<BTreeMap<CliId, Option<Channel>>>` to `PatchSettingsBody` (round-2 B2 — the write-side field; the read-side field on `Settings` was already added in Phase 2's 2.0b). `Option<Channel>` per key: `Some(ch)` sets, `None`/`null` clears.
- [x] **6.2** `rust/vst-routes/src/settings.rs` — extract `pub(crate) fn validate_default_channel_overrides(entries: &BTreeMap<CliId, Channel>, resolver: fn(CliId) -> Box<dyn AgentPlugin>) -> Result<(), SettingsRouteError>` (round-2 M4 — a **pure, independently unit-testable** function, not inline validation with no seam): rejects `Channel::Json` when `!resolver(cli).supports_json()`; rejects `Channel::Pty` unconditionally (the override's valid range is `{Tmux, Json}` only). Call it from `patch_settings` with the real `resolve_plugin`. New `SettingsRouteError` variant mirroring `SkillPathsNotAbsolute`'s shape.
- [x] **6.3** `rust/vst-routes/src/settings.rs::patch_settings` — **per-key merge**, not whole-map replace (round-2 B2): for each `(cli, value)` in the body's `default_channel_by_cli`, mutate `raw["defaultChannelByCli"]` one key at a time (same `raw[...] = ...` pattern already used for `markdownStyle`) — `Some(ch)` sets `raw["defaultChannelByCli"][cli.as_str()] = ch`, `None` removes that key from the object (leaving sibling keys untouched). This is what makes concurrent single-CLI toggles from two Settings rows safe without a client-side `Settings` fetch first.
- [x] **6.4** Confirm (no new code, just verification) that Phase 2's `list_supported_clis` update (2.1b/2.1c/4.0) already exposes the override-aware `default_channel` + `default_channel_overridden` — this phase does not touch that call site again.
- [x] **6.5** `web-ui/src/components/settings/SettingsPanel.tsx:34` — change `label: "Modes"` to `label: "Agents & modes"`; keep `id: "modes"`.
- [x] **6.6** `web-ui/src/api/types.ts` — add `defaultChannel: Channel` + `defaultChannelOverridden: boolean` to `SupportedCli`; add a `defaultChannelByCli?: Partial<Record<CliId, "tmux" | "json">>` param to the `updateSettings`/PATCH-body type (**not** to `Settings` — round-2 B2/M4: this is a write-only param, and the type deliberately excludes `"pty"`, unlike the general `Channel` type, to match Decision 8's validation range). `web-ui/src/api/mock.ts` — `getSupportedClis` gains `defaultChannel`/`defaultChannelOverridden` on all 4 fixtures; `updateSettings` applies a `defaultChannelByCli` patch so the mock can actually be observed changing (round-2 m4 — without this, 6.T4/4.T10 have nothing to assert against). (Note: the write-only value type is `"tmux" | "json" | null` — the extra `null` allows the UI to *clear* an override by sending `null`, per 6.7; `"pty"` remains excluded.)
- [x] **6.7** `web-ui/src/components/agent/CliDetectionPanel.tsx` (`variant === "settings"` only, guard with the existing `variant` prop) — per detected-CLI row, add a small Terminal/Rich-Chat toggle. Label the plugin-default option with "(default)" using `cli.defaultChannelOverridden` (round-2 m3 — lets a user tell "this is the plugin's own default" from "this is my override", and gives a way to *clear* one): selecting that labeled option sends `null` for this CLI's key; selecting the other sends the explicit value. Disable the Rich-Chat option when `!cli.supportsJson`. `onChange` → `api.updateSettings({ defaultChannelByCli: { [cli.id]: valueOrNull } })` — a **single-key** body (the per-key merge write path, 6.3, makes this safe with no prior `Settings` fetch), then refetch `getSupportedClis()` (mirrors `createBundle`'s existing refetch pattern at `:48-52`). Render nothing for an undetected CLI.
  - **Post-ship revisions (round-3, not in the original 6.7 wording — P1):** the toggle became a `<Select>` dropdown (not two radios), pinned to the row's far right next to the create/recreate-bundle button, same row at every viewport width. The label suffix changed from "(default)" to "(built-in)" (the field's own "Default channel" label already says "default" once; a second "(default)" on the option read as circular — round-3 n2). The field's visibility gate is `hasAnyMode || cli.defaultChannelOverridden`, not just `cli.detected` (round-3 m5 — a live override must stay reachable even if all of that CLI's modes are later deleted). `onChannelChange` now tracks a per-CLI in-flight/error state (`pendingChannelChanges`, `channelErrors`) so a failed `PATCH` surfaces an inline message and disables the select instead of failing silently (round-3 m3). The daemon's `default_channel_overridden` (`modes.rs`) was fixed to mean "effective value differs from the plugin's own default" rather than "a key exists" (round-3 M1) — the prior meaning let a redundant/stale override mislabel which option was "(default)" and silently discard a user's pick.
  - **Unrelated components touched, then reverted (round-3 M2/M3):** an earlier pass also renamed `DraftComposer.tsx`'s "⌨ Terminal" radio and `ChannelToggleButton.tsx`'s "⇄ Terminal" button to "Terminal (Tmux)"/"Terminal - Tmux". Both were reverted to plain "Terminal": DraftComposer's radio sits directly above a "Use tmux" checkbox that can turn the same selection into a `pty` session, so promising "Tmux" there is sometimes false; `ChannelToggleButton` is a space-constrained Rich-Chat-pane overlay button outside this feature's scope, and widening its label risks squeezing it on narrow panes. Only `CliDetectionPanel`'s own settings dropdown keeps a qualifier ("Terminal (tmux)"), where it's unambiguous and there's room for it.

**Verify phase 6:**
- [x] **6.T1** Integration — `PATCH /settings` with `defaultChannelByCli: { cursor: "json" }` (cursor `supports_json()==true`) → `200`; a follow-up `PATCH` with `{ agy: "json" }` (a *different* key) leaves `cursor`'s override intact (per-key merge, round-2 B2).
- [x] **6.T2** Unit — `validate_default_channel_overrides` with a **stub resolver** whose plugin returns `supports_json() == false` (round-2 M4 — this is what makes the test possible at all; no production `CliId` has this property, so a real `resolve_plugin` can't exercise the rejection path) → `Json` entry rejected; `Tmux` entry for the same stub → accepted. Separately: any entry of `Pty` → rejected regardless of `supports_json`.
- [x] **6.T3** Integration — `GET /supported-clis` reflects a just-set override's `defaultChannel`/`defaultChannelOverridden` immediately (no caching lag) — same assertion as Phase 2's 2.T12, exercised here via the actual `PATCH` → `GET` round trip.
- [x] **6.T4** Integration (web-ui, `CliDetectionPanel.test.tsx`) — settings variant: toggling a CLI row's selector persists via `updateSettings` with a single-key body; the row reflects the new value after the refetch; selecting the "(default)"-labeled option sends `null` and the row's `defaultChannelOverridden` flips back to `false`; the Rich-Chat option is disabled (not merely hidden) for a `!supportsJson` CLI; the `oobe` variant renders no selector at all.
- [x] **6.T5** Regression — sending `null` for a CLI's key clears its override; `GET /supported-clis`'s `defaultChannel` for that CLI reverts to the plugin's own default and `defaultChannelOverridden` becomes `false`.
- [x] **6.T6** Host file note: 6.T1/6.T5 live in `rust/vst-routes/tests/utility_routes.rs` (existing home of `PatchSettingsBody`-shaped tests, round-2 m4); 6.T2 is a plain unit test colocated with `validate_default_channel_overrides` in `settings.rs`; 6.T3 can live in either.

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `rust/vst-agents/src/plugin.rs` | **Modified** | 1.1, 2.6 | Contract: `AgentPlugin` gains required `fn default_channel(&self) -> Channel`; doc comment gets the `supports_json` invariant note |
| `rust/vst-agents/src/claude.rs` | **Modified** | 1.2 | Impl returns `Channel::Json` |
| `rust/vst-agents/src/cursor.rs` | **Modified** | 1.3 | Impl returns `Channel::Json` |
| `rust/vst-agents/src/opencode.rs` | **Modified** | 1.4 | Impl returns `Channel::Json` |
| `rust/vst-agents/src/agy.rs` | **Modified** | 1.5 | Impl returns `Channel::Tmux` |
| `rust/vst-agents/src/registry.rs` | **Modified** | 2.6, 2.T10 | New invariant test: `default_channel()==Json ⇒ supports_json()` |
| `rust/vst-types/src/domain.rs` | **Modified** | 2.0a, 4.0c | `CliId` gains `PartialOrd, Ord` (round-2 B1); `DraftConfig` gains `channel_explicit: Option<bool>` |
| `rust/vst-types/src/rest/settings.rs` | **Modified** | 2.0b, 6.1 | `Settings.default_channel_by_cli: Option<BTreeMap<CliId, Channel>>` (read, Phase 2); `PatchSettingsBody.default_channel_by_cli: Option<BTreeMap<CliId, Option<Channel>>>` (write, Phase 6, round-2 B2) |
| `rust/vst-routes/src/settings.rs` | **Modified** | 2.1b, 6.2-6.3 | `load_default_channel_overrides()` free fn, per-entry parsing (round-2 M1/M3, Phase 2); `validate_default_channel_overrides()` pure fn + per-key-merge `patch_settings` (round-2 B2/M4, Phase 6) |
| `rust/vst-routes/tests/utility_routes.rs` | **Modified** | 6.1, 6.T1-6.T2, 6.T5-6.T6 | 7 existing `PatchSettingsBody` literals updated for the new field; new override write/validate/clear tests |
| `rust/vst-routes/src/oobe.rs` | **Modified** | 6.1 | `PatchSettingsBody` literal at `:177` updated for the new field |
| `rust/vst-routes/src/modes.rs` | **Modified** | 1.6, 2.1, 2.1c, 4.0 | `stub_plugin_base!()` gains `default_channel`; new `resolve_mode` (two-pass, round-2 m1)/`resolve_effective_default_channel` (total, round-2 M4) helpers; `list_supported_clis` exposes override-aware `default_channel`/`default_channel_overridden` |
| `rust/vst-agents/src/json_agent_session/mod.rs` | **Modified** | 1.7 | `NoopPlugin` gains `default_channel` |
| `rust/vst-agents/tests/json_agent_session_queue.rs` | **Modified** | 1.8 | `MockTurnPlugin`, `HangingTurnPlugin` gain `default_channel` |
| `rust/vst-routes/src/worktrees.rs` | **Modified** | 2.2 | `create_worktree`: mode resolved before channel, no `.expect()`; `None` branch uses override-aware effective default — no struct field, calls the free fn (round-2 M1) |
| `rust/vst-routes/src/sessions.rs` | **Modified** | 2.3-2.5 | Mode validation moved ahead of defaulting (M1); same-CLI-scoped inheritance using the real `SessionContext` shape (B3/Decision 6, round-2 m1 fix); draft-start paths use the existing resolved `mode_id: &str` param, not `draft_config.mode_id` (M3, round-2 m1 fix) |
| `rust/vst-routes/src/projects.rs` | **Modified** | 2.8, 2.T14 | `create_new_project`'s two hardcoded `Channel::Tmux` sites (`:872,1004`) now resolve the effective default (round-2 M2 — a previously missed consumer) |
| `rust/vst-types/src/rest/modes.rs` | **Modified** | 4.0 | `SupportedCli` gains `default_channel: Channel` (override-aware) and `default_channel_overridden: bool` (round-2 m3) |
| `rust/vst-cli/src/commands/agent/create.rs` | **Modified** | 3.1-3.2, 3.1b | Contract: `channel: Option<String>` (was `String`); body sends `Option<Channel>` — no new flag needed, `--channel` is already the complete interface |
| `rust/vst-cli/src/commands/worktree/create.rs` | **Modified** | 3.3-3.4, 3.3b | Same contract change |
| `rust/vst-cli/tests/worktree_project_file_daemon_contract.rs` | **Modified** | 3.5, 3.T1, 3.T6 | Assertions updated for `Option<String>`; doc-comment wording; new body-capturing `run_worktree_create` mock test |
| `rust/vst-cli/tests/session_mode_contract.rs` | **Modified** | 3.T2-3.T5, 3.T6 | Assertions updated for `Option<String>`; new omitted-flag test; new body-capturing `run_agent_create` mock test (extends existing `POST /api/sessions` mock at `:404-424`) |
| `web-ui/src/components/draft/DraftComposer.tsx` | **Modified** | 4.0c-4.5 | Contract: channel default follows server-reported `defaultChannel` for `selectedCli` (no CLI-id literal) unless `channelExplicit` |
| `web-ui/src/components/draft/DraftComposer.test.tsx` | **Modified** | 4.T6-4.T10 | New Tier-2, upgrade-path, capability-override, initial-load-race, and settings-override coverage |
| `web-ui/src/components/settings/SettingsPanel.tsx` | **Modified** | 6.5 | `label: "Modes"` → `"Agents & modes"`; `id` unchanged |
| `web-ui/src/components/agent/CliDetectionPanel.tsx` | **Modified** | 6.7, round-3 | Per-detected-CLI "Default channel" `<Select>` (post-ship: dropdown not radios, far-right pinned, gated on `hasAnyMode \|\| defaultChannelOverridden`, "(built-in)" labeling, in-flight/error state, OOBE-only "✓ all created" kept) |
| `web-ui/src/components/agent/CliDetectionPanel.test.tsx` | **Modified** | 6.T4, round-3 | Override toggle/clear/disabled-state coverage, plus round-3's OOBE-confirmation, live-override-without-modes, and in-flight-error regressions |
| `web-ui/src/components/chat/ChannelToggleButton.tsx` | **Modified**, then **reverted** | round-3 M3 | Briefly renamed "Terminal"→"Terminal - Tmux"; reverted (outside this feature's scope, unplanned, squeezes a space-constrained overlay button) — **not otherwise touched by this feature** |
| `web-ui/src/components/chat/ChannelToggleButton.test.tsx` | **Modified**, then **reverted** | round-3 M3 | Assertions round-tripped with the above revert |
| `rust/vst-routes/src/modes.rs` | **Modified** | round-3 M1, n3 | `default_channel_overridden` now means "effective value differs from plugin default", not "a key exists"; `load_default_channel_overrides()` hoisted out of the per-CLI loop |
| `rust/vst-routes/src/projects.rs` | **Modified** | round-3 n4 | One-line comments on the two (unreachable) `.unwrap_or(Channel::Tmux)` fallbacks, documenting the deliberate Tmux/Json split vs. `sessions.rs`'s equivalent |
| `rust/vst-routes/src/settings.rs` | **Modified** | round-3 n5 | Doc comment on `load_default_channel_overrides`'s `home_dir()` vs. `Paths` path-resolution convention |
| `rust/vst-routes/tests/utility_routes.rs` | **Modified** | round-3 M1 | New `test_supported_clis_redundant_override_is_not_reported_as_overridden` |
| `web-ui/src/api/types.ts` | **Modified** | 4.0b, 4.0c, 6.6 | `SupportedCli` gains `defaultChannel`/`defaultChannelOverridden`; `DraftConfig` gains `channelExplicit`; write-only `defaultChannelByCli` param on the settings-update type (narrowed to `"tmux"\|"json"`, excludes `"pty"` — round-2 M4) |
| `web-ui/src/api/mock.ts` | **Modified** | 4.0b, 6.6 | 4 `SupportedCli` fixtures gain `defaultChannel`/`defaultChannelOverridden`; `updateSettings` mock applies a `defaultChannelByCli` patch (round-2 m4 — without this, 6.T4/4.T10 have nothing to observe) |
| `skill/SKILL.md` | **Modified** | 5.1-5.2, 5.9 | §5/§6 wording + inheritance-change callout; possible version-marker bump |
| `rust/vst-agents/assets/agent-system-prompt.md` | **Modified** | 5.3 | New note on default-channel behavior |
| `rust/vst-agents/assets/agent-subagent-richchat.md` | **Modified** | 5.4 | Corrected default-channel claim + inheritance-change note |
| `docs/API-CONTRACT.md` | **Modified** | 5.5-5.6, 5.10 | Remove stale `--json` flag doc; per-CLI `--channel` default wording; `/settings` + `/supported-clis` field docs (round-2 m2) |
| `docs/SESSION-EXECUTION.md` | **Modified** | 5.7 | Per-CLI default note added to "tmux mode (default)" heading |
| `AGENTS.md` | **Modified** | 5.8 | § Agent plugin "Current plugin methods" table gains `default_channel()` row |
