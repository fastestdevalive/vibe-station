# Feature Report: Rich-Chat Default, VCS Layout, Skill Autocomplete, CLI-Agnostic Skills

**Branch:** `rich-default-deepseek`  
**Commit:** `b124d67`  
**Date:** 2026-09-09

---

## Changes Implemented

### 1. Rich Chat as Default Channel

New agents and sessions now default to **Rich Chat (json)** instead of Terminal.

**Daemon** (`sessions.ts`, `worktrees.ts`): When neither `channel` nor `useTmux` is passed, the route now defaults to `"json"`. Explicit terminal requests (`channel: "tmux"` or `useTmux: true`) still work as before — legacy back-compat (`resolveUseTmux`) was left untouched.

**UI** (`NewAgentDialog.tsx`, `NewSessionDialog.tsx`, `NewTabDialog.tsx`, `DirectAgentDialog.tsx`): All dialogs now open with Rich Chat pre-selected. Terminal selections now send an explicit `channel: "tmux"` rather than omitting it (which would have silently created a json session under the new daemon default).

> Before: new agents opened in Terminal mode by default  
> After: new agents open in Rich Chat mode by default

---

### 2. VCS Tab — Stacked Layout

The branch name chip and "Diff from" checkbox in the VCS panel are now **stacked vertically**, both left-aligned. The refresh button stays at the far right.

**Files:** `VcsPanel.tsx`, `workspace.css`

A new `vcs-panel__title-col` CSS class wraps the title group and diff toggle in a `flex-direction: column` container with `4px` gap. The diff-toggle label was moved out of `vcs-panel__bar-actions` (which now holds only the refresh button).

```
Before:  [Commits  branch-chip]  [□ Diff from main] [↻]
After:   [Commits  branch-chip]                     [↻]
         [□ Diff from main    ]
```

---

### 3. Skill Autocomplete in New Agent Dialog

The **prompt field** in New Agent Dialog now supports `/skill` autocompletion when Rich Chat is selected.

**File:** `NewAgentDialog.tsx`

- On dialog open, fetches `GET /skills` and maps results to `Command[]`
- When channel is `json`, renders `SkillEditor` (Lexical-based, with popover autocomplete) instead of a plain `<textarea>`
- When channel is `terminal`, falls back to the original `<textarea>`
- The `SkillEditor` carries `ariaLabel="Initial prompt"` for accessibility

> Typing `/` in the prompt field now shows the skill autocomplete popover — same UX as the chat composer.

---

### 4. Skills CLI-Agnostic

All CLIs (Claude, OpenCode/Deepseek, Cursor, Agy) now show **all user skills** in their autocomplete, regardless of whether the CLI implements `formatSkillDirective`.

**File:** `jsonAgent.ts`

- `cliSupportsSkillDirective()` now always returns `true` for the `assembleMeta` / rebuild paths — user skills appear in the `commands_update` event for every CLI
- The live `getMeta()` path uses the precise `typeof this.plugin.formatSkillDirective === "function"` check — CLIs with the formatter get full directive expansion; others get the skill name in the completion list

> `/sdlc` now autocompletes on Deepseek just as it does on Claude.

---

## Process

| Step | Agent | Result |
|---|---|---|
| Plan | Sonnet (in-harness) | 5-phase plan |
| Review plan | Opus (in-harness) | 4 blockers caught, plan adjusted |
| Implement | Deepseek vst subagent (`change-channel-file`) | All 5 changes + tests |
| Code review | Opus vst subagent | 2 bugs found |
| Fix bugs | Deepseek vst subagent | Both fixed, amend-committed |

**Single commit:** `b124d67 feat: rich-chat default, VCS layout fix, skill autocomplete in new-agent dialog, CLI-agnostic skills`

---

## Bugs Fixed During Review

1. **`getMeta()` live path used always-true skill gate** — fixed to inline-check `typeof this.plugin.formatSkillDirective === "function"` so cursor/agy sessions don't try to dispatch unfomattable skill directives at send time.

2. **Orphaned `<label>` element** in New Agent Dialog after SkillEditor swap — removed; accessibility preserved via `ariaLabel` prop on the editor's contenteditable.

---

*Screenshots: UI is served via `scripts/dev-sandbox.sh` on this machine. Key surfaces to verify: New Agent dialog (Rich Chat pre-selected, `/` autocomplete in prompt), VCS panel tab (stacked layout), any non-Claude session (Deepseek) with user skills configured.*
