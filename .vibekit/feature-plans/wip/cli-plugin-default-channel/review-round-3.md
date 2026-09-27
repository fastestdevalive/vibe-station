**Verdict: approve-with-changes**

# Review round 3 — cli-plugin-default-channel (final, lighter pass)

Scope: `git diff 7722269f..HEAD` (3 commits). Focus: (a) the post-round-2 UI polish in `CliDetectionPanel.tsx` + the "Terminal - Tmux" rename, (b) remaining daemon-side resolution edge cases, (c) plan drift. Items already covered by `review-round-1.md`/`review-round-2.md` are not re-litigated.

Summary: the daemon resolution is sound. Every default site goes through `resolve_effective_default_channel`, mode canonicalization now runs before defaulting, and same-CLI inheritance is correct. One real correctness bug remains at the daemon↔UI boundary (M1). The UI polish has two copy/UX regressions (M2, M3) and one layout risk (m1). The plan no longer describes what shipped (P1).

---

## Major

### M1 — `defaultChannelOverridden` means "a key exists", not "the effective value differs from the plugin default", so the UI can label the wrong option "(default)" and silently undo the user's pick
- **Where:** `rust/vst-routes/src/modes.rs:361` (`default_channel_overridden = overrides.contains_key(&cli)`), consumed by `web-ui/src/components/agent/CliDetectionPanel.tsx:73-81` (`defaultOption = overridden ? other : current`)
- **Problem:** the UI never learns the plugin's own default. It infers it as "the other option whenever `overridden` is true". There are two ways for a key to exist while the effective value equals the plugin default:
  1. **A redundant override.** `PATCH /settings {defaultChannelByCli:{claude:"json"}}` passes `validate_default_channel_overrides` (claude supports json), and so does a hand-edited `config.json`. The daemon then reports `defaultChannel:"json", defaultChannelOverridden:true`.
  2. **A stale-invalid override.** A `json` override on a plugin that no longer `supports_json()`: `resolve_effective_default_channel` drops it and falls back to the plugin default, but the `overridden` flag stays `true`.
- **Failure:** in case 1, claude's row shows "Rich Chat" selected and **"Terminal - Tmux (default)"**, which is wrong. The user picks Terminal, and because `value === defaultOption` the UI sends `null`. That clears the key, the refetch comes back as `json`, and the select snaps back to Rich Chat. The user asked for Terminal and got Rich Chat with no error; only a second attempt works. The UI alone can't produce this state, but the documented public API (`docs/API-CONTRACT.md:160`), agents, and hand edits can.
- **Fix (pick one; the first is the smallest):**
  - In `list_supported_clis`, compute `default_channel_overridden = default_channel != plugin.default_channel()`. That covers both cases in one line. Update the `SupportedCli` doc comment and `API-CONTRACT.md:167` to say "effective value differs from the plugin default".
  - And/or normalize on write in `patch_settings`: if `Some(ch)` equals `resolve_plugin(cli).default_channel()`, `map.remove(key)` instead of inserting it.
  - Most robust: expose `pluginDefaultChannel` on `SupportedCli` and have the UI use it directly instead of inferring "the other one".
  - Add a daemon test: seed `{claude:"json"}` in `config.json` and assert `defaultChannelOverridden == false`.

### M2 — The "⌨ Terminal - Tmux" label in DraftComposer contradicts the "Use tmux" checkbox directly below it
- **Where:** `web-ui/src/components/draft/DraftComposer.tsx:1100` (radio label) vs `:1107-1110` (`useTmux` checkbox) and `:300` (`channel: isJson ? "json" : useTmux ? "tmux" : "pty"`)
- **Problem:** the radio now promises tmux, but unchecking "Use tmux (recommended…)" produces a `pty` session. The UI says "Terminal - Tmux" while shipping a non-tmux terminal. The plain "⌨ Terminal" label was accurate because the checkbox chose the flavor.
- **Fix:** revert the DraftComposer radio to "⌨ Terminal". Alternatively, drive the suffix from the checkbox, but reverting is simpler, and the rename is outside this feature's scope anyway.

### M3 — The "Terminal - Tmux" rename reached `ChannelToggleButton`, which is outside the feature, unplanned, and breaks the established qualifier style
- **Where:** `web-ui/src/components/chat/ChannelToggleButton.tsx:73-74` (+ 4 assertions in `ChannelToggleButton.test.tsx`)
- **Problem:**
  - This is the Rich Chat pane's corner overlay button, not the settings surface this feature is about. It isn't in the plan's Files table.
  - It makes a space-constrained overlay button about 7 characters wider (the `channel-toggle-button__text` span is exactly what gets squeezed on narrow panes).
  - Its label no longer matches the `chat.css:190` comment ("⇄ Terminal toggle").
  - The established pattern for a technical qualifier is a parenthetical, as in "Rich Chat (json based)" (AGENTS.md "UI terminology"; the COPY table's own header comment). A dash suffix ("Terminal - Tmux") is a new, third style.
- **Fix:** revert `ChannelToggleButton` COPY and its test to "⇄ Terminal"/"Terminal". In the settings dropdown only (`CliDetectionPanel.tsx:182`), where the qualifier genuinely helps, use `Terminal (tmux)` to match the `(json based)` precedent. If the button rename is wanted, do it as its own commit and update the `chat.css` comment.

---

## Minor

### m1 — The row never wraps: the right-pinned action group can overflow on narrow or mobile settings
- **Where:** `CliDetectionPanel.tsx:83-97` (row: `display:flex`, no `flexWrap`) and `:137-144` (action group: `flexShrink: 0`)
- **Problem:** consider a detected CLI with missing starter modes and at least one mode. The action group then holds "Recreate N"/"Create starter modes" (~150px), a `gap`, and a `width:auto` select whose widest option is "Terminal - Tmux (default)" (~190px). With `flexShrink:0` that group can't shrink, so at about 360px the left column (name, detected badge, fallback warning text) gets crushed to near-zero width or the row overflows horizontally. The tests (jsdom) can't catch this.
- **Fix:** add `flexWrap: "wrap"` to the row (and `rowGap`), or stack the select under the button (`flexDirection: "column", alignItems: "flex-end"`) below a breakpoint. Check it once in the dev sandbox at mobile width.

### m2 — Dropping "✓ all created" also removed the OOBE's only success confirmation
- **Where:** `CliDetectionPanel.tsx:145` (`missingCount > 0 && …`; the `missingCount === 0` branch was deleted for **both** variants)
- **Problem:** in the settings variant, the default-channel select now fills that slot, so dropping the label there is fine. In `variant="oobe"`, though, clicking "Create starter modes" now makes the button disappear and leaves an empty right side, with no positive signal that it worked. That's a behavior change to the onboarding flow that the plan never called for.
- **Fix:** keep the label for the OOBE only (`variant === "oobe" && missingCount === 0 && <span data-testid=cli-all-created-…>✓ all created</span>`) and restore the old assertion for the OOBE variant in `CliDetectionPanel.test.tsx`.

### m3 — `onChannelChange` has no error handling or in-flight guard
- **Where:** `CliDetectionPanel.tsx:76-81`
- **Problem:**
  - A 400 (`InvalidDefaultChannel`) or a network failure becomes an unhandled promise rejection with no user-visible message. The controlled select just silently stays on the old value.
  - Two quick changes can race: their refetches can resolve out of order and leave a stale `supportedClis`.
- **Fix:**
  - Add a `.catch` that sets a small inline error (the same pattern other settings panels use).
  - Optionally disable the select while a PATCH is in flight.

### m4 — Nobody refreshes the panel when settings change elsewhere
- **Where:** `CliDetectionPanel.tsx:34-49`, which subscribes only to `mode:*` events
- **Problem:** an override changed in another tab or device (or via API/agent) doesn't show up here until remount. That's harmless given the per-key merge, but the panel shows stale "(default)" labeling, which feeds M1-style confusion.
- **Fix:** if the daemon broadcasts `settings:updated` for this field, refetch `getSupportedClis()` on it. Otherwise note it as a known limitation.

### m5 — Hiding the field behind "≥1 mode exists" makes an existing override invisible and uneditable
- **Where:** `CliDetectionPanel.tsx:68,164`
- **Problem:** the gate itself is reasonable, since with no mode the default can't apply. But if a user sets an override and later deletes all of that CLI's modes, the override persists invisibly and re-applies when a mode is recreated. The same happens for an undetected CLI (`cli.detected &&` gate, line 136).
- **Fix:** low priority. Render the select when `hasAnyMode || cli.defaultChannelOverridden` (after M1's fix makes that flag trustworthy), so a live override is always reachable. Or just document the gate in the plan (see P1).

---

## Nits

- **n1** — `CliDetectionPanel.tsx:98-135` and `:136-189`: the JSX inside the row `<div>` sits 2 spaces too shallow (the new wrapper and the `cli.detected &&` block are aligned with the row's opening tag, not nested under it). This is cosmetic, and ESLint doesn't catch it; reindent.
- **n2** — The field label "Default channel" plus the option "Rich Chat (default)" reads as "default" twice with two meanings (the effective setting vs. the plugin's built-in value). Consider "(built-in)" or "(recommended)" for the option suffix.
- **n3** — `rust/vst-routes/src/modes.rs:359`: `load_default_channel_overrides()` is called inside the per-CLI `.map`, so it reads and parses `config.json` 4 times per `GET /supported-clis`. Hoist it above `SUPPORTED_CLIS.iter()`.
- **n4** — Inconsistent unreachable fallbacks: `projects.rs:846,995` use `.unwrap_or(Channel::Tmux)` while `sessions.rs` and the draft-start sites use `.unwrap_or(Channel::Json)` for the same "mode vanished between validation and lookup" race. Pick one. Json matches the pre-existing `create_normal_session` behavior; Tmux matches the old project-create behavior. Either way, add a one-line comment on which was chosen.
- **n5** — `load_default_channel_overrides()` reads `home_dir()/.vibe-station/config.json` while `patch_settings` writes `self.paths.vst_home()/config.json`. These are identical in production, and this mirrors the existing `load_modes()` vs `ModeRoutes.load_modes()` split, so it isn't a bug. It is a latent divergence if `Paths` is ever rooted somewhere other than `$HOME`. Worth a comment at the function.

---

## Daemon-side resolution: checked, no new issues
- `create_normal_session` (`sessions.rs:640-745`): canonicalization happens before defaulting. Same-CLI inheritance only applies when both CLIs resolve (a deleted parent mode means no inheritance, and that's documented). A `use_tmux`-only request skips the default and keeps the legacy path. `Terminal` stays hard `Tmux`. The json-capability gate still runs after defaulting. ✓
- `create_worktree` (`worktrees.rs:529-545`): a single `resolve_mode`, and an unresolvable mode is a `Validation` error (no `.expect`). `use_tmux: Some(_)` keeps its legacy meaning. ✓
- Draft-start (`sessions.rs:1919,2073`) resolves off the resolved `mode_id` parameter, and the placeholders at `:228` and `:4671` are commented. ✓
- `create_new_project` startAgent (`projects.rs:831-884, 981-1031`): `tmux_name` is conditional on `use_tmux`, and the channel is persisted as the effective value. ✓ (Note: this drops `resolve_use_tmux(None)`, but that was always `true`, so there's no behavior loss.)
- `resolve_effective_default_channel` is total, and `validate_default_channel_overrides` rejects `Pty` and `Json` on a non-json plugin. ✓ The one gap is the **reporting** side (`overridden`), covered in M1.

---

## P1 — Plan drift (does it matter? yes, moderately)

The plan (`plan-cli-plugin-default-channel.md`) and `.sdlc-state.yaml` don't describe the shipped UI:

| Plan says | Shipped | Action |
|---|---|---|
| Req 10 (`:64`): "**each detected-CLI row** gets a Default channel selector" | Only rows with **≥1 mode** for that CLI (`hasAnyMode`) | Amend Req 10 and 6.7 with the gate and its rationale. The test "hides the default-channel field until at least one mode exists" has no plan item; add 6.T5. |
| 6.7 (`:504`) / Research (`:150`): "Terminal/Rich-Chat toggle (same two-option shape as DraftComposer's channel radios)" | A `<Select>` dropdown, pinned far-right next to the bundle button | Update 6.7 wording. |
| Nothing | "✓ all created" label removed (both variants), plus the row restructured into left info / right actions | Add to 6.7 (and resolve m2). |
| Nothing | "Terminal - Tmux" wording in `DraftComposer.tsx:1100`, `ChannelToggleButton.tsx:73-74`, and `ChannelToggleButton.test.tsx` | Either revert (M2/M3) or add both files to the Files & Phase Impact table with a phase item. |
| `**Status:** Pending` (`:15`) with every checkbox `[x]` | Implemented | Set it to Implemented or In review. |
| `.sdlc-state.yaml`: `plan: pending`, `awaiting_phase: implement`, `review_rounds: 2`, `commit: null` | Implemented; round 3 done | Bump it to `review_rounds: 3`, advance the phase, and record the head commit. |

Why it matters: the plan is the document a future pass (or the round-1/2 "don't re-fix this" comments) relies on. Req 10 now contradicts the code, and a future agent "fixing" the panel to match Req 10 would remove a deliberate gate. The Files table also omits two touched components, so it isn't a reliable blast-radius list.

---

## Suggested order
1. M1 (daemon one-liner plus a test), then M2 and M3 (revert or unify the copy), then m2 (OOBE label).
2. P1 plan and state updates in the same commit as the fixes.
3. m1 (verify at mobile width in the dev sandbox), m3, and the nits as time allows.
