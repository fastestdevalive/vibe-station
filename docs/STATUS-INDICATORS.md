# Status indicators — the two-axis matrix

> **This file is the single source of truth for session status colour, glyph, and dashboard
> bucketing.** Any change to `statusColor.ts`, `bucketForRollup`, `StatusDot`, the
> `--status-*`/`--pr-*` tokens, or the `LifecycleState`/`PrStatus` unions **must** update the
> matrix below in the same commit. See `AGENTS.md` § Status indicators.

Background/rationale: `.vibekit/reports/2026-08-16-pr-detection-broken-root-cause-and-fix.md` (decisions D5, D17–D21).

---

## Two orthogonal axes

| Axis | Field | Values | Written by |
|------|-------|--------|-----------|
| **Lifecycle** — is the agent busy? | `session.lifecycle.state` (`LifecycleState`) | `not_started, working, idle, waiting_for_human, done, exited` | `daemon/src/services/lifecycle.ts` poller, 1s |
| **PR** — what happened to the branch? | `session.pr` (`PrStatus`) | `none, draft, open, merged, closed` | `daemon/src/services/prPoller.ts`, 10s |

- **Invariant:** each poller writes **only** its own field. Neither ever touches the other's.
  This is what removed the three-writer clobber race — do not reintroduce cross-writes.
- `session.pr.prBranch` records the branch the PR was found on. A PR is only ever rendered when
  `prBranch === worktree.branch` — a stale PR after a branch switch must never colour anything.

## The matrix

Dot colour resolved by `resolveStatusClass()` — `web-ui/src/lib/statusColor.ts`.
Bucket resolved by `bucketForRollup()` — `web-ui/src/components/layout/DashboardPanel.tsx`.

| Lifecycle | PR | Dot | Glyph | Home bucket |
|---|---|---|---|---|
| `working` | any (`open`/`merged`/`draft`/`closed`/`none`) | 🟡 yellow | `●` | **Working** |
| `not_started` | any | neutral, dashed | `◐` | **Working** |
| `waiting_for_human` | `open` | 🔵 blue | `●` | **PR** |
| `waiting_for_human` | `merged` | 🟢 green | `●` | **PR** |
| `waiting_for_human` | `draft` / `closed` / `none` / unset | 🔴 red | `!` | **Waiting** |
| `idle` | `open` | 🔵 blue | `●` | **PR** |
| `idle` | `merged` | 🟢 green | `●` | **PR** |
| `idle` | `draft` / `closed` / `none` / unset | neutral | `○` | **Waiting** |
| `done` | `open` | 🔵 blue | `✓` | **Finished** |
| `done` | `merged` | 🟢 green | `✓` | **Finished** |
| `done` | `draft` / `closed` / `none` / unset | neutral | `✓` | **Finished** |
| `exited` | `open` | 🔵 blue | `×` | **Finished** |
| `exited` | `merged` | 🟢 green | `×` | **Finished** |
| `exited` | `draft` / `closed` / `none` / unset | neutral, dimmed | `×` | **Finished** |

### Precedence — dot colour (D18, D21)
```
1. working | not_started            → "working"            🟡
2. pr = merged   (branch-matched)   → "pr-merged"          🟢
3. pr = open     (branch-matched)   → "pr-open"            🔵
4. waiting_for_human                → "waiting_for_human"  🔴
5. idle                             → null                 neutral
6. done | exited                    → PR colour if any, else neutral   (D21)
```
- `draft` and `closed` **never** drive colour or bucket — they are informational only.
- `working` beats PR on purpose: if you ask for more work on a branch that already has a PR, the
  in-progress signal is the more current fact.
- PR beats `waiting_for_human` on purpose: an agent idles at its prompt immediately after opening
  a PR, so red would otherwise mask blue permanently.

### Precedence — dashboard bucket (D19)
```
1. done | exited        → Finished     (checked FIRST, unconditionally)
2. working | spawning   → Working
3. pr = open | merged   → PR
4. waiting_for_human | idle → Waiting
5. otherwise            → Finished
```
- **Colour and bucket deliberately disagree for `done`/`exited`** (D21): the dot keeps the PR
  colour so you can see the branch landed, but the card stays in Finished, because `done` is an
  explicit manual user action meaning "I am finished with this". Do not "fix" this to agree.
- `idle` lives in **Waiting**, not Finished — an idle worktree is open work, not done.
  Consequence: the Waiting column contains both 🔴 `waiting_for_human` (agent needs you) and
  neutral `○` `idle` (nothing happening). This is known and intentional.

## Tokens

`web-ui/src/styles/tokens.css` — defined in **both** `[data-theme="dark"]` and
`[data-theme="light"]` blocks. Never a bare hex in a component or another stylesheet.

| Token | dark | light |
|---|---|---|
| `--status-working` | `#eab308` | `#a16207` |
| `--status-waiting` | `#ef4444` | `#dc2626` |
| `--pr-open` | `#3b82f6` | `#1d4ed8` |
| `--pr-merged` | `#22c55e` | `#15803d` |
| `--pr-draft` | `#8a8a8a` | `#737373` |
| `--pr-closed` | `#6b6b6b` | `#737373` |

- Per-theme is mandatory: a single hex fails light-mode contrast (`#22c55e` on white ≈ 2.1:1 vs
  the ≥3:1 bar for non-text UI).
- Non-colour cues that must survive any recolour: `tile--spawning { border-style: dashed }`,
  `tile--exited { opacity: .9 }`.

## Where each surface reads from

| Surface | File | Notes |
|---|---|---|
| Sidebar rows | `LeftSidebar.tsx` (4 `<StatusDot>` sites) | worktree rows roll up; session rows are per-session |
| Dashboard cards | `DashboardPanel.tsx` | worktree cards **and** direct (worktree-less) agent cards |
| Canvas tile border | `WorkspaceCanvas.tsx` | gated on the `showAgentStatusBorders` setting |
| Agent pane border | `AgentPaneSlot.tsx` | single session, so no rollup |
| VCS panel PR pill | `workspace.css` `.vcs-pr--*` | must use the same `--pr-*` tokens |

## Per-session vs per-worktree

- The **dot** is per session.
- The **bucket** is per worktree, rolled up over its non-archived agent sessions:
  - `hasLiveActivity` — ANY session `working`/`not_started` → Working, short-circuiting the rest
    (so one sibling's `waiting_for_human` can't hide another's `working`).
  - the bucket's PR comes from `worktreePrStatus()`, which reads the **`isMain`** session only,
    matching the session `prPoller` writes to.
- Archived sessions (`archivedAt != null`) are excluded from bucketing entirely.

## Testing without a daemon

Press **Ctrl+Shift+D** in the web UI for the dev state simulator
(`web-ui/src/components/dev/DevStatePanel.tsx`). It drives both axes and patches the client
stores directly, so no GitHub, no daemon writes, no restart. It sets `prBranch` to the session's
real worktree branch automatically — otherwise the branch guard filters the PR out and nothing
renders.
