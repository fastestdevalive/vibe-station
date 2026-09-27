# Review — Round 2: plan-cli-plugin-default-channel.md

Reviewed against `feat/cli-plugin-default-channel` @ `7722269f`. Focus: Decision 8 (per-CLI default-channel
override), 2.1b/2.1c, Phase 6, the `server.rs` wiring claims, `get_settings()` on the request path, Decision 7's
write-time gate, and the Files & Phase Impact table.

## Verdict: **approve-with-changes**

- The round-1 fixes (B1-B3, M1-M5) are folded in correctly. The core idea holds up: one pure
  `resolve_effective_default_channel` helper with the override as a second input.
- The new override layer has **three compile/contract blockers**:
  - `BTreeMap<CliId, _>` does not compile.
  - `PatchSettingsBody` is never given the field, so nothing can write the override.
  - Phases are ordered so that Phase 2 depends on a type Phase 6 adds.
- The `server.rs` claims are accurate as far as they go. They undercount the fallout, though: about 25 construction
  sites across 8+ files, none of them in the Files table. There is also a much smaller design that avoids all of it
  (M1).
- Requirement 12 ("every consumer goes through one helper") misses one real consumer: `POST /projects/create`.

---

## Blocking

### B1. `BTreeMap<CliId, Channel>` does not compile: `CliId` does not derive `Ord`
- **Where:** plan lines 173-174, 198-204 (Decision 2 snippet), 286-287 (Decision 8), 337 (2.1b), 431 (6.1), 465.
  Code: `rust/vst-types/src/domain.rs:41` has `#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]`
  on `CliId`, with no `PartialOrd`/`Ord`.
- **Problem:** every `BTreeMap<CliId, …>` in the plan fails with `the trait bound CliId: Ord is not satisfied`
  when `insert`/`get` is called. The Files table does not list `domain.rs` for this change.
- **Fix:** pick one:
  - add `PartialOrd, Ord` to `CliId`'s derive (`domain.rs:41`) and add that to 6.1 and the Files table; or
  - use `HashMap<CliId, Channel>`. `CliId` is already `Hash`, and serde_json writes unit-variant enum keys as
    strings either way.
- `BTreeMap` gives deterministic key order in `config.json`, so adding the derive is the nicer choice.

### B2. `PatchSettingsBody` never gets `default_channel_by_cli`, so the override can't be written, and "clear" can't be expressed
- **Where:** plan 6.1 (adds the field to `Settings` only), 6.2 (validates "each `default_channel_by_cli` entry" on
  PATCH), 6.T5 (`{ agy: null }`). Code: `rust/vst-types/src/rest/settings.rs:31-45`. `PatchSettingsBody` is a
  **separate struct** from `Settings`, and `server.rs:3521` deserializes the PATCH into it.
- **Problem:**
  - As written, `PATCH /settings { defaultChannelByCli: … }` is silently ignored, because serde drops the unknown
    field. 6.T1 would fail on the "persisted" assertion.
  - Even with the field added as `BTreeMap<CliId, Channel>`, 6.T5's `{ "agy": null }` fails axum's `Json`
    extraction with a 422. There is no way to clear an override on the wire.
  - 6.7's client-side `{ ...(settings.defaultChannelByCli ?? {}), [cli.id]: v }` implies whole-map replace.
    `CliDetectionPanel` never fetches `Settings` (it only calls `getSupportedClis()`, `CliDetectionPanel.tsx:29,52`),
    so `settings` is undefined there. Two quick toggles on different rows would also race: the later write clobbers
    the earlier one from a stale snapshot.
- **Fix:**
  - Add `pub default_channel_by_cli: Option<BTreeMap<CliId, Option<Channel>>>` to `PatchSettingsBody`.
  - Give it **server-side per-key merge** semantics inside the existing `write_lock` RMW in `patch_settings`:
    `Some(ch)` sets the key and `null` removes it.
  - The UI then sends only `{ defaultChannelByCli: { [cli.id]: value } }` and needs no `Settings` fetch.
  - Update the literal in `rust/vst-routes/src/oobe.rs:177` and the 7 literals in
    `rust/vst-routes/tests/utility_routes.rs`. `PatchSettingsBody` has no `Default`, so each literal lists every
    field. Add all of these to the Files table.
  - Also add `defaultChannelByCli?` to the TS `PatchSettings`/`updateSettings` param type, not just to `Settings`
    (6.6).

### B3. Phase ordering: Phase 2 can't compile or test without Phase 6's type and read path
- **Where:** 2.1b, 2.2 (`self.settings_routes.get_settings().await.default_channel_by_cli`), 2.3-2.5, 2.T12, 4.0,
  4.T10 all use `Settings.default_channel_by_cli`. That field is only added in **6.1**, and is only read from
  `config.json` in **6.3**.
- **Problem:** Phase 2's "Verify" gate (`cargo build` + 2.T12) can't pass on its own. 2.T12 in particular needs the
  field to exist *and* be populated from disk.
- **Fix:** move 6.1 (the `Settings` field), 6.3 (the `get_settings` read) and B2's `PatchSettingsBody` field into
  Phase 2, as 2.0a/2.0b. Phase 6 keeps only PATCH validation (6.2), the UI (6.5-6.7) and its tests.

---

## Major

### M1. The `settings_routes` field wiring is much larger than 2.1c says, and there is a far smaller alternative
- **The `server.rs` claims are accurate:**
  - `worktree_routes` is built at `:375`, `session_routes` at `:406`, `mode_routes` at `:421`, and
    `settings_routes` at `:423`.
  - `SettingsRoutes::new` depends only on `opts.paths` and `opts.broadcaster`, so moving it above `:375` is a pure
    reorder. Risk #7 is correct.
  - `SettingsRoutes` is `#[derive(Clone)]` with an `Arc` write lock (`settings.rs:88-106`).
- **What 2.1c and the Files table miss:**
  - `SessionRoutes` has a **hand-written `Clone` impl** (`sessions.rs:309-337`). The new field must be added there
    too.
  - `SessionRoutes` is built by **struct literal** in 10 test sites across `rust/vst-routes/tests/sessions_group_{a,b1,b2,c,d}.rs`
    (2 each). All 10 break. 2.T13 mentions only `b2`.
  - `ModeRoutes::new(store, broadcaster)` has 10 call sites: 8 in `tests/modes_and_open.rs`, 1 in `tests/oobe.rs`
    and 1 in `modes.rs`. `WorktreeRoutes::new(...)` has 4 test sites: `tests/worktrees.rs` ×2, `tests/projects.rs`
    and `tests/lsp_test.rs`. Adding a *required* field through `new()` breaks all of them. The plan doesn't say
    whether the field is a constructor arg or a builder.
- **Recommended simpler design:** don't add a field at all. Add a free fn next to the existing free
  `modes::load_modes()`:

  ```rust
  // settings.rs — same shape/location convention as modes::load_modes() (home_dir()-rooted, honours with_home())
  pub fn load_default_channel_overrides() -> BTreeMap<CliId, Channel> { /* read home_dir()/.vibe-station/config.json,
      parse "defaultChannelByCli" entry-by-entry (see M3) */ }
  ```

  - Every consumer that pairs this with `resolve_mode()` already reads `modes.json` through `home_dir()`, so the two
    reads come from one root.
  - Production is equivalent: `main.rs:222` uses `Paths::default_home()` = `$HOME/.vibe-station`, the same as
    `home_dir()`.
  - Tests already redirect `home_dir()` with `with_home()` (`sessions_group_b2.rs:156-174`,
    `tests/worktrees.rs:296-298`), so 2.T12 just writes `config.json` next to `modes.json`.
  - This removes 2.1c entirely: no `server.rs` reorder, no `Clone`-impl edit, no ~24 test-literal edits.
  - `SessionRoutes` has no `paths` field and already uses `Paths::default()` ad hoc (`sessions.rs:1866`), so
    injecting `SettingsRoutes` into it would be the only DI of its kind there.
- **If you keep the field approach:**
  - Add `with_settings_routes(...)` builders. `new()` should default-construct from `Paths::default()` so existing
    `new()` callers still compile.
  - Update the `SessionRoutes` `Clone` impl and all 10 literals.
  - List every one of these files in the Files table.
  - Note that in `tests/worktrees.rs`, `routes.paths` points at a *different* tempdir (`:365`, `vst_data_dir`) than
    `modes.json` (`temp_home`). A `SettingsRoutes` built from `routes.paths` reads `config.json` from a different
    root than `resolve_mode` reads `modes.json`. That is easy to get wrong in 2.T12.

### M2. Requirement 12 misses a consumer: `POST /projects/create` with `startAgent` hardcodes `Channel::Tmux`
- **Where:** `rust/vst-routes/src/projects.rs:872` (worktree arm) and `:1004` (direct arm) of `create_new_project`
  (`:617`). Both build an **agent** `SessionRecord` with a resolved `mode_id` and `channel: Some(Channel::Tmux)`.
  `StartAgent` (`vst-types/src/rest/projects.rs:34-39`) has no `channel` field.
- **Problem:** this route is reachable from `vst project create --start-agent` (`vst-cli/src/commands/project/create.rs:111`)
  and from the web-ui (`client.ts:1243`). After the plan, a claude-mode agent created this way comes up in **tmux**,
  while every other create path gives Json, and a user override is ignored. This contradicts Requirement 3/12's
  "no hardcoded default" and the plan's own "Today/After" row.
- **Fix:** either
  - route both arms through `resolve_mode` + `resolve_effective_default_channel`, with `use_tmux` derived from the
    result, and add a test; or
  - list it explicitly in Out of Scope with the reason, so the claim that every consumer goes through the helper
    stays true.
- Also add a one-line note that `sessions.rs:2955` (reset: `session.channel.unwrap_or(Channel::Tmux)`) is a legacy
  record read, not a create-time default, and is intentionally excluded. It is otherwise a grep hit that looks like a
  missed consumer.

### M3. Whole-map deserialization of `defaultChannelByCli` means one bad entry silently drops **all** overrides (contradicts Risk #8)
- **Where:** 6.3 ("deserializing each value as `Channel`" via the `raw.get(...)` pattern); Risk #8 (line 308).
- **Problem:**
  - The natural read is `serde_json::from_value::<BTreeMap<CliId, Channel>>(v.clone()).ok()`, the same pattern as
    `markdownStyle` at `settings.rs:148-150`. That fails on the **whole map** if any key isn't a current `CliId`
    variant: a CLI removed in a later release, a hand-edit typo, or a newer daemon's config read by an older one.
    Every override is then silently lost.
  - Risk #8's claim that a stale entry is "simply never read" is only true with per-entry parsing.
- **Fix:** iterate the raw object and `from_value` each key and value independently, skipping (and optionally
  `tracing::warn!`-ing) entries that don't parse. Correct Risk #8 to say it depends on this. Add a test with an
  unknown key next to a valid one.

### M4. Decision 7's write-time gate can't be tested as planned, and doesn't protect the read path
- **Where:** Decision 7/8, 6.2, 6.T2. Code: every production plugin returns `supports_json() == true`
  (`claude.rs:413`, `cursor.rs:465`, `opencode.rs:530`, `agy.rs:503`).
- **Problems:**
  1. **6.T2 can't be written.** "A hypothetical/mocked CLI whose plugin has `supports_json()==false`" isn't
     reachable. `CliId` is a closed enum, and `SettingsRoutes` has no plugin-resolver seam (unlike `ModeRoutes`'s
     `plugin_resolver`, `modes.rs:202,230`). The gate is dead code in production today.
  2. **The write-time check alone isn't enough.** If a plugin later flips `supports_json` to `false` (or a hand
     edit sets it), a *persisted* `Json` override makes every default-path create 400 with "X does not support JSON
     chat mode" (`sessions.rs:695-704`, `worktrees.rs:542-554`). That is the exact failure M4 of round 1 was meant to
     prevent.
  3. **`Channel::Pty` isn't addressed.** `Channel` has three variants (`domain.rs:148-152`: `Tmux`, `Pty`, `Json`).
     6.2 only says Json is gated and Tmux is always accepted, so `{ claude: "pty" }` would be accepted and turn
     every default agent into a direct-pty agent. The CLI rejects `--channel=pty`, and the UI selector offers only
     two options.
- **Fix:**
  - Extract a pure `validate_default_channel_overrides(map, resolver: fn(CliId) -> Box<dyn AgentPlugin>) -> Result<(), SettingsRouteError>`.
    Call it from `patch_settings` with `resolve_plugin`, and unit-test it with a stub resolver whose plugin returns
    `supports_json() == false`. That makes 6.T2 real.
  - Reject `Pty` with its own `SettingsRouteError` variant (`validation_error`).
  - Make the helper total, so a persisted override can never be worse than no override:

    ```rust
    match overrides.get(&cli).copied() {
        Some(Channel::Json) if !plugin.supports_json() => plugin.default_channel(),
        Some(ch @ (Channel::Tmux | Channel::Json)) => ch,
        _ => plugin.default_channel(),
    }
    ```

    Extend 2.T11 to cover both fallbacks.
  - Narrow the TS type to `defaultChannelByCli?: Partial<Record<CliId, "tmux" | "json">>` (6.6), not `Channel`,
    which includes `"pty"`.

### M5. Uncached `get_settings()` on the request path: latency is fine, but the read can see a torn file
- **Latency is not a concern:**
  - `POST /sessions`/`POST /worktrees`/`/start` run at human or agent rate.
  - These paths already call the free `load_modes()` (a blocking `std::fs::read_to_string` inside async,
    `modes.rs:57-66`) 2-3 times per request.
  - `list_supported_clis` already does a PATH probe per CLI (`binary_checker`, `modes.rs:322`).
  - One more small async JSON read is noise. **No cache is needed**, and adding one would create the "caching lag"
    6.T3 explicitly guards against.
- **Correctness is the concern:**
  - `patch_settings` writes with `tokio::fs::write` (`settings.rs:305`), which truncates and then writes.
  - Readers (`read_raw_config`, `settings.rs:114-120`) take no lock, and a parse failure becomes `{}`.
  - A create that races any settings PATCH (search toggles, theme, the new selector) can read an empty or partial
    file and silently fall back to the plugin default for that one session.
  - `main.rs:64,289,378` (the startup and browser-epoch persist) also write `config.json` outside `write_lock`.
- **Fix:**
  - Add a line to the plan saying no caching is intentional.
  - Either make `patch_settings`'s write atomic (write `config.json.tmp`, then `rename`), which is one small change
    that also hardens every other settings field, or accept the window and document it in Risks.
  - Also, don't call the full `get_settings()` just to read one field. It builds the whole struct, including
    `cliToken`/`tauriToken` and default skill paths. Use a narrow accessor, which M1's free fn already is.

---

## Minor

### m1. Snippet/type inaccuracies an implementer will trip on
- **Decision 3 / 2.5:** `resolve_mode(&draft_config.mode_id)` doesn't typecheck, because `DraftConfig.mode_id` is
  `Option<String>` (`domain.rs:493`). Both draft-start functions already receive a resolved `mode_id: &str`
  parameter (the `start_new_worktree` signature, around `sessions.rs:1847`, and the existing-worktree variant around
  `:1862`). Use that parameter.
- **Decision 6 snippet (lines 264-274):**
  - `source_mode` doesn't exist.
  - `source` is a `SessionContext` enum, not a session, so `source.channel` doesn't compile. The real code
    destructures `SessionContext::Worktree { session, .. } | Direct { session, .. }` (`sessions.rs:642-651`).
  - `.or(parent_cli)` is redundant, because `mode_id` has already been overwritten with the parent's mode at `:645-647`
    when omitted.
  - Say explicitly that the parent's CLI comes from `resolve_mode(session.mode_id)`. If the parent's mode has since
    been deleted, `parent_cli = None`. Specify whether that still inherits. Recommendation: don't inherit, and fall
    through to the default.
- **Decision 2 `resolve_mode` snippet (line 194):** `find(|m| m.id == input || m.name == input)` is a *single* pass.
  `resolve_mode_id` (`modes.rs:92-101`) does id-first over the whole list, then name. If mode A's **name** equals
  mode B's **id** and A comes first, `resolve_mode` returns A while `resolve_mode_id` returns B. The default channel
  would then be computed from a different mode than the one persisted. Keep the two-pass order.

### m2. Round-1 m8 (document `SupportedCli.defaultChannel`) was not carried into Phase 5, and `/settings` docs are now stale too
- `docs/API-CONTRACT.md:159-160` documents `GET`/`PATCH /settings` field lists. Add `defaultChannelByCli`, with its
  merge/null semantics (B2) and validation (M4).
- Wherever `/supported-clis` is documented, add `defaultChannel` and note that it is override-aware.
- Add both to 5.5/5.6 or a new 5.10.

### m3. Settings UI has no "reset to plugin default" and no cross-tab refresh
- 6.7 displays only the *effective* value. Once a user picks a value, it is pinned forever: picking the same value as
  the plugin default still persists an override, and a future plugin default change won't reach them.
- 6.T5 tests clearing, but no UI path produces a clear.
- **Fix:** show which value is the plugin default, e.g. "Terminal (default)". Selecting the plugin default sends
  `null` (B2's clear). This needs a `pluginDefaultChannel` field on `SupportedCli` alongside the override-aware
  `defaultChannel`, or a boolean `defaultChannelOverridden`.
- **Cross-tab refresh:** `patch_settings` broadcasts only `SettingsThemeUpdated` (`settings.rs:322-325`).
  `DraftComposer` fetches `clis` once on mount (`DraftComposer.tsx:219-221`), so an already-open draft or another tab
  keeps the old default until remount. Say in Risks that this is acceptable. It is: the daemon resolves at create
  time anyway when the draft sends no explicit channel.

### m4. 6.T4 test file and mock need naming
- 6.T4 belongs in `web-ui/src/components/agent/CliDetectionPanel.test.tsx` (it exists).
- `web-ui/src/api/mock.ts`'s `updateSettings`/`getSettings` (`:1413`) and `getSupportedClis` (`:1250`) must apply
  the override, or 6.T4/4.T10 can't observe a change through the mock. Add both to 6.6 and the Files table.
- 6.T1-6.T3/6.T5 have no host file named. Settings route tests live in `rust/vst-routes/tests/utility_routes.rs`.

### m5. Research line 151's claim needs a correction
- It says the three structs are "constructed once in `server.rs` and cloned per request". That is true for server
  wiring, but `SessionRoutes` is not `#[derive(Clone)]`: it has a manual impl that re-snapshots `direct_ptys`
  (`sessions.rs:309-337`). Any new field has to be threaded there by hand (M1).

---

## Files & Phase Impact — gaps to add

| File | Why | Ref |
|------|-----|-----|
| `rust/vst-types/src/domain.rs` | `CliId` derive `PartialOrd, Ord` (and `DraftConfig.channel_explicit`, already listed) | B1 |
| `rust/vst-types/src/rest/settings.rs` | also `PatchSettingsBody.default_channel_by_cli: Option<BTreeMap<CliId, Option<Channel>>>` | B2 |
| `rust/vst-routes/src/oobe.rs` | `PatchSettingsBody` literal at `:177` | B2 |
| `rust/vst-routes/tests/utility_routes.rs` | 7 `PatchSettingsBody` literals; host for 6.T1-6.T3/6.T5 | B2, m4 |
| `rust/vst-routes/src/projects.rs` | `create_new_project` `:872,1004` hardcoded `Tmux` (fix or declare out of scope) | M2 |
| `rust/vst-routes/tests/sessions_group_{a,b1,c,d}.rs` | `SessionRoutes` literals (only if keeping the field approach) | M1 |
| `rust/vst-routes/tests/{modes_and_open,oobe,projects,lsp_test}.rs` | `ModeRoutes::new`/`WorktreeRoutes::new` call sites (only if the constructor changes) | M1 |
| `web-ui/src/components/agent/CliDetectionPanel.test.tsx` | 6.T4 host | m4 |
| `docs/API-CONTRACT.md` | also `:159-160` `/settings` and `/supported-clis` field docs, not only the CLI lines | m2 |
| `rust/vst-daemon/src/server.rs` | **remove** from the table if you adopt M1's free-fn design | M1 |

- The table's phase column is also inconsistent with B3: `rust/vst-types/src/rest/settings.rs` and the
  `get_settings` part of `rust/vst-routes/src/settings.rs` should read Phase 2, not 6.
