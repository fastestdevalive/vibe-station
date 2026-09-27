# Review — Round 1: plan-cli-plugin-default-channel.md

Reviewed against `feat/cli-plugin-default-channel` @ `7722269f`.

## Verdict: **approve-with-changes** (one issue is close to needs-rework)

- The Rust core (trait method, 4 plugins, 5 test doubles, `create_worktree` reorder) is sound, and most line references still match.
- **Phase 4 (web-ui) does not work as designed.** The `channelTouchedRef = initialConfig?.channel != null` check is true for almost every real draft (issue B1), so the new effect would almost never run. The UI also hardcodes `"agy"`, which breaks the plugin invariant in AGENTS.md (issue B2).
- **The CLI change is a behaviour change the plan doesn't mention** (issue B3): it turns subagent channel inheritance on for the first time. The plan says that behaviour is already correct.
- Several stale docs are missing from the Change Map, and the draft-start and draft-record defaults in the daemon still hardcode `Json`.

---

## Blocking

### B1. `channelTouchedRef` starts as `true` for nearly every draft, so the mode-follow effect is dead code
- **Where:** plan Decision 5, Phase 4.1. Code: `web-ui/src/components/draft/DraftComposer.tsx:165-167, 276-281, 360-363`; `web-ui/src/components/layout/LeftSidebar.tsx:1128`; `web-ui/src/lib/projectDraft.ts:35`.
- **Problem:**
  - `LeftSidebar.tsx:1128` (entryPoint `worktree`) and `lib/projectDraft.ts:35` (entryPoint `tab`) create the draft with `channel: "json"`. For those drafts, `initialConfig.channel` is present on first mount, so the ref is `true` and the effect never runs. The plan's Research line 102 says these lines "do not need to change". That is wrong: they are exactly what disables the feature.
  - `currentConfig` always serialises `channel` (`DraftComposer.tsx:278`). The effect at `:360-363` calls `scheduleSave()` on every `currentConfig` change, including the first render after `setModeId(ms[0].id)`. About 1.2 s after any draft opens, `channel` is persisted. On reopen it counts as "touched", even if the user never clicked a radio.
  - Tier 2 → Tier 1 upgrade (`DraftComposer.tsx:419-424`, `draftConfig: { ...currentConfig, entryPoint: "global" }`) also carries `channel` across. The remounted Tier 1 composer then treats it as touched.
- **Fix:** persist the "user explicitly chose" bit instead of inferring it from whether `channel` is present:
  - Add `channelExplicit?: boolean` to `DraftConfig` in **both** `web-ui/src/api/types.ts:~206` **and** `rust/vst-types/src/domain.rs:491`. The Rust side matters because `sessions.rs:1660,1682` deserialize `draft_config` into the typed struct. Without the Rust field, an extra UI-only key is silently dropped on the round trip.
  - Initialise the ref from `initialConfig?.channelExplicit === true`.
  - Set it in both radio `onChange`s (`:1062`, `:1071`) and serialise it in `currentConfig`.
  - Drop `channel: "json"` from `LeftSidebar.tsx:1128` and `projectDraft.ts:35`, or leave it, since it no longer means "touched" either way.
  - Correct the Research bullet (line 102) and the Change Map to list these files. The plan cites `ProjectHomeTab.tsx:35`, but the line is actually `web-ui/src/lib/projectDraft.ts:35`, and `ProjectHomeTab.tsx:35` has no such line.

### B2. `selectedCli === "agy"` in the UI breaks the plugin invariant
- **Where:** plan Decision 5, Phase 4.2.
- **Problem:** AGENTS.md § Agent plugin says to never branch on CLI id outside the plugin. The plan's own success criterion is "calling code never inspects `CliId` again". A 5th CLI with default `Tmux` would compile fine and then silently get Rich Chat in the UI.
- **Fix:** expose the plugin value over REST, the same way `supportsJson` is already exposed:
  - Add `default_channel: Channel` to `SupportedCli` (vst-types).
  - Fill it in `rust/vst-routes/src/modes.rs:303-341` (`list_supported_clis`, via `plugin.default_channel()`).
  - Add `defaultChannel: "json" | "tmux"` to `web-ui/src/api/types.ts:~464` and to the three `mock.ts:1255+` entries.
  - In the effect, use `clis.find(c => c.id === selectedCli)?.defaultChannel ?? "json"`.
  - Add this to the Change Map, plus a Phase 2 test that `GET /supported-clis` returns `defaultChannel: "tmux"` for agy.

### B3. The CLI change turns on subagent channel inheritance for the first time. It is a behaviour change, and it conflicts with the agy default
- **Where:** plan Out of Scope line 37, Phase 2.T4, Phase 3. Code: `rust/vst-routes/src/sessions.rs:647-649`; `rust/vst-cli/src/commands/agent/create.rs:123-131,169`.
- **Problem:**
  - Today the CLI always sends `channel: Some(Tmux)` by default. `inherited_channel` is only consulted when `data.channel.is_none()` (`sessions.rs:647`), so **`vst agent create` from the CLI has never inherited the parent's channel**.
  - After this plan, omitting `--channel` sends `None`, so every CLI-spawned subagent inherits the parent's channel. In practice this is probably the fix `agent-subagent-richchat.md:43-44,65-66` already promises. But it is the largest user-visible change in the feature, and the plan describes it as "already correct / unchanged".
  - It also collides with the feature's goal. 2.T4 asserts that a Json parent spawning an **agy**-mode subagent (explicit `--mode=<agy>`) gets `Json`. That contradicts `agent-subagent-richchat.md:72-75` ("prefer tmux for an agy subagent even while you yourself are in Rich Chat").
- **Fix:**
  - Rewrite Out-of-Scope line 37 and the "Today/After" table to say plainly that CLI-spawned subagents now inherit the parent's channel.
  - Make an explicit decision and add it as Decision 6:
    - **Recommended:** inherit the parent's channel only when the mode is also inherited (no `--mode` passed), or when the explicit mode's CLI equals the parent's CLI. Otherwise use the plugin default. This keeps "agy → tmux" true for a Json parent spawning an agy child.
    - The alternative is to keep 2.T4 as written, and then update the `agy` exception text in `agent-subagent-richchat.md:72-75` so the agent passes `--channel=tmux` explicitly.
  - Add tests: (a) a CLI-shaped request (no channel, `source_agent_id` set) inherits `Json`; (b) whichever agy-child behaviour Decision 6 chooses.

---

## Major

### M1. `create_normal_session`: `find_mode` runs before `resolve_mode_id`, so mode-name inputs get the wrong default
- **Where:** plan Decision 3, Phase 2.2. Code: `rust/vst-routes/src/sessions.rs:657-666` (defaulting) vs `:687-694` (resolution); `rust/vst-routes/src/modes.rs:92-101,119-121`.
- **Problem:**
  - `resolve_mode_id` accepts either a mode **id or name**. `find_mode` matches **id only**.
  - `defaulted_channel` is computed before `mode_id` is canonicalised. So `vst agent create --mode=my-agy-mode` (name form, which the docs allow) fails `find_mode`, falls back to `Json`, and the agy session comes up in Rich Chat.
  - The plan calls the fallback "unreachable in practice". It is reachable.
- **Fix:** move the `r#type == Agent` validation and the `resolve_mode_id` block (`:681-694`) above the channel block, the same reorder Decision 2 does for worktrees, then compute the default from the resolved id. Add a test that creates an agent session by mode **name** with an agy mode, with no channel, and asserts `Tmux`. Moving the validation up is safe: none of the channel code can fail, so error ordering is unchanged.

### M2. `expect("just resolved")` can panic a request handler (TOCTOU on `modes.json`)
- **Where:** plan Decision 2 snippet, Phase 2.1.
- **Problem:** `resolve_mode_id` and `find_mode` each call `load_modes()` (a disk read) separately. If a mode is deleted or renamed concurrently between the two calls, a daemon request thread panics.
- **Fix:** don't `expect`. Either:
  - map `None` to the same `Validation("Mode '…' not found")` error, or
  - add `modes::resolve_mode(input) -> Option<Mode>` that returns the full `Mode` from one `load_modes()` call, and use it in both `worktrees.rs` and `sessions.rs`. This also removes the duplicate disk read.

### M3. Daemon draft-start paths still hardcode `Json`
- **Where:** not in the plan. Code: `rust/vst-routes/src/sessions.rs:1881` (`start_new_worktree`), `:2025` (existing-worktree / tab start), `:4616` (draft `SessionRecord` built with `channel: Some(Channel::Json)`), `:228` (global-draft session view).
- **Problem:** Requirement 3's wording ("an agent session with no explicit/inherited channel resolves via the plugin") is not met for `POST /sessions/:id/start` when `draftConfig.channel` is absent. That is exactly the state B1's fix creates if the placeholder `channel: "json"` is removed from the draft scaffolds.
- **Fix:** at `:1881` and `:2025`, replace `draft_config.channel.unwrap_or(Channel::Json)` with the plugin default for `draft_config.mode_id` (via the M2 helper), falling back to `Json`. Add it to Phase 2 and the Change Map, with a test that starts a draft whose config has no channel and an agy mode, and asserts `Tmux`. Leave `:228`/`:4616` as they are; they are placeholder values for a `drafting` record. Add a comment saying so.

### M4. Missing invariant: `default_channel() == Json` requires `supports_json() == true`
- **Where:** plan Phase 1 tests. Code: `rust/vst-agents/src/plugin.rs:317-319` (`supports_json` defaults to `false`); `sessions.rs:695-704`, `worktrees.rs:542-554` (the 400 gate).
- **Problem:** a future plugin that implements `default_channel → Json` but forgets `supports_json` would 400 on **every** create without `--channel` ("X does not support JSON chat mode"). That is worse than today.
- **Fix:** add a unit test in `rust/vst-agents/src/registry.rs` that iterates `SUPPORTED_CLIS` and asserts `p.default_channel() != Json || p.supports_json()`. Also mention the rule in the trait method's doc comment.

### M5. Stale docs missing from the Change Map
- `docs/API-CONTRACT.md:35`: "`--channel` selects `tmux` (default)". Needs the per-CLI wording.
- `docs/API-CONTRACT.md:24`: `vst worktree create` still documents a non-existent `--json` flag and no `--channel`. This drift predates the plan, but fix it in the same edit.
- `docs/SESSION-EXECUTION.md:5`: heading "tmux mode (default)". Add a line clarifying that the per-CLI default comes from the plugin.
- `rust/vst-cli/tests/worktree_project_file_daemon_contract.rs:7`: already in the plan (3.5).
- `skill/SKILL.md:1`: `vst-skill-version` marker. Check whether it must be bumped when §5 changes, so installed copies refresh.
- AGENTS.md § "Current plugin methods" table: add a `default_channel()` row (required). That table is the canonical list of plugin methods.

---

## Minor

### m1. Research inaccuracies
- **Line 92:** says `AgentPlugin` has "4 required methods". It actually has 8: `name`, `default_model`, `default_mode_icon`, `prompt_delivery`, `get_launch_command`, `get_environment`, `get_ready_signal`, `compose_launch_prompt`. Insertion after `compose_launch_prompt` (`plugin.rs:258`) is still fine.
- **Phase 1.1:** `Channel` is re-exported as `vst_types::Channel` (`vst-types/src/lib.rs:21`, `pub use domain::*`). `plugin.rs:32` already imports from `vst_types::{…}`, so extend that list instead of adding a `vst_types::domain::Channel` import.
- **Line 105:** says "5 test-only impls across 3 files". Confirmed accurate: `modes.rs:854,871`, `json_agent_session/mod.rs:1069`, `tests/json_agent_session_queue.rs:68,228`. The macro is at `modes.rs:~820-850`.
- **Other line refs that still match:** `sessions.rs:630,657-668,681-685`, `worktrees.rs:507,531-540,786`, `registry.rs:33`, `agent/create.rs:9-33,120-131,169`, `worktree/create.rs:16-42,133-145,170`, `DraftComposer.tsx:162-273,1059-1071`.

### m2. CLI parser lines are not listed in Phase 3
- **Where:** `rust/vst-cli/src/commands/agent/create.rs:79-86` and `worktree/create.rs:93-100` assign `opts.channel = <String>`.
- **Problem:** these must become `Some(...)`. The compiler will catch it, but the checklist should list it.
- **Fix:** add "3.1b / 3.3b: parser arms wrap in `Some`".

### m3. 3.T6: the cited mock pattern doesn't capture request bodies, and the body shape is already known
- `session_mode_contract.rs:374-454` and `top_level_commands_contract.rs:576-670` are mock **response** bodies. They never inspect the request's `channel`.
- 3.T6 needs a body-capturing mock (for example `Arc<Mutex<Option<serde_json::Value>>>` in the axum handler).
- Both `CreateSessionBody` (`vst-types/src/rest/sessions.rs:77`) and `CreateWorktreeBody` (`rest/worktrees.rs:11`) are `#[skip_serializing_none]`. Assert that the **`channel` key is absent**, not `null`, and remove the "check serde attrs" hedge.
- Mount the mock under `/api/...` (AGENTS.md § CLI).
- Put the worktree variant in `worktree_project_file_daemon_contract.rs`, not `top_level_commands_contract.rs`. That file has no `run_worktree_create` mock today, and the plan's Files table lists the wrong file.
- Also add a companion assertion: explicit `--channel=tmux` still sends `"channel":"tmux"`, so the explicit override can't regress into `None`.

### m4. The CLI contract test list is complete, with two notes
- The breaking sites are exactly `session_mode_contract.rs:120,153,605,619` and `worktree_project_file_daemon_contract.rs:68,98`.
- `top_level_commands_contract.rs:256` is a `Session` **response** struct (`channel: Channel`) and is unaffected. The plan correctly does not list it.
- 3.T1 wording: line 98 is the explicit `--channel json` case, so assert `Some("json".into())`. Line 68 is the no-flag case, so assert `None`. The plan has this right, but its Research line 100 says `Option<"tmux".into())`, which is a typo. Fix it to avoid confusion.
- Consider replacing the `session_mode_contract.rs:619` literal (`"tmux"`) with `None`, so the default path gets exercised end-to-end against the mock too.

### m5. Route tests need modes on disk
- **Where:** plan 2.T1-2.T7.
- **Problem:**
  - `find_mode`/`resolve_mode_id` read `modes.json` via `load_modes()`. The existing session route tests inject `json_unsupported: Arc::new(|_| None)` (`tests/sessions_group_*.rs`) and seed modes per the note in `sessions_group_b2.rs:157`.
  - The plan doesn't say which test files host 2.T*, or that an **agy** mode must be seeded.
  - Direct `resolve_plugin(...)` calls in `create_normal_session` also bypass the injection pattern that `json_unsupported` set up for testability.
- **Fix:**
  - Put 2.T1-2.T4 in `rust/vst-routes/tests/sessions_group_b2.rs` (it already seeds modes) and 2.T5-2.T7 in `rust/vst-routes/tests/worktrees.rs`, seeding one claude, one cursor and one agy mode.
  - Optionally add an injected `default_channel_for_mode: Arc<dyn Fn(&str) -> Option<Channel>>` next to `json_unsupported` (`sessions.rs:293`) for consistency.

### m6. 2.T7 is weak as a regression test
- Invalid mode already returns `Validation("Mode '…' not found")` before and after the change.
- Also assert that a **valid** mode with `use_tmux: Some(false)` and no channel still yields `pty`. This is the legacy branch the reorder touches, and nothing covers it today.
- Plan Risk #1 is effectively moot (a typed enum can't produce a daemon-side invalid-channel error). Close it.

### m7. Web-ui edge cases missing from 4.T*
- **4.T5:** Tier 2 (`/draft/new`, entryPoint `global`) with an agy mode defaults to Terminal, and `createWorktree` receives `channel: "tmux"`. Extend the existing `DraftComposer.test.tsx:110-125` case.
- **4.T6:** a draft reopened after an autosave where the user never touched the radio still follows a mode change. This regresses without B1's persisted flag.
- **4.T7:** Tier 2 → Tier 1 upgrade keeps `channelExplicit` semantics.
- **4.T8:** switching from an agy mode (defaulted to Terminal) to claude flips back to Rich Chat. Switching to a `supportsJson: false` CLI still forces Terminal, and the `jsonSupported` effect (`:271-273`) must not set the touched flag.
- **4.T9:** an effect-order race. On first load `modes` is `[]`, so `selectedCli` is `undefined` and the new effect sets `"json"`. That is fine only if the effect writes nothing to the touched ref. Assert that no `updateDraft` is persisted with `channelExplicit: true` unless a radio was clicked.
- Name the file for all of these: `web-ui/src/components/draft/DraftComposer.test.tsx`. Update the `mock.ts` `getSupportedClis` fixtures for `defaultChannel` (B2).
- **useTmux interaction:** Terminal plus a restored `useTmux: false` serialises as `"pty"`. The agy default should mean `tmux`, so the default-follow effect should also set `useTmux(true)` when it picks Terminal and the channel is untouched. Otherwise a stale `useTmux: false` makes the "default" `pty`.

### m8. Status and API docs
- No `docs/STATUS-INDICATORS.md` impact. Confirmed: nothing in the "two-file change" list is touched.
- If B2 is adopted, document the new `SupportedCli.defaultChannel` field wherever `GET /supported-clis` is documented in `docs/API-CONTRACT.md`.

---

## Backward-compatibility summary
- **Persisted sessions/worktrees:** unaffected. `default_channel()` only runs at creation. Plan Risk #2 is correct.
- **Old CLI → new daemon:** the old CLI keeps sending `channel: "tmux"` explicitly, so behaviour is unchanged. Fine.
- **New CLI → old daemon:** omitted `channel` makes the old daemon default agent sessions and worktrees to `Json`, including agy. agy `supports_json() == true` (`agy.rs:503`), so nothing fails, but agy gets Rich Chat. This is acceptable, but note it in the plan, since the CLI and daemon ship from one repo but can drift in `~/.cargo/bin`.
- **Behaviour change for existing CLI users:** a bare `vst agent create` / `vst worktree create` with a claude/cursor/opencode mode now yields **Rich Chat instead of tmux**. Together with B3 (inheritance), this is the headline change. Put it in the commit message and in SKILL.md §5, not only as a per-CLI table.
- **Stored drafts** that already contain `channel` (with no `channelExplicit`) will be treated as untouched under B1's fix. For a draft saved on agy with the old implicit `"json"`, the UI would switch it to Terminal on reopen. That is the intended behaviour, but add it to Risks.
