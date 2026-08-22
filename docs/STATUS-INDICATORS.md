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
| **PR** — what happened to the branch? | `session.pr` (`PrStatus`) | `none, draft, open, merged, closed` | `daemon/src/services/prPoller.ts`, 30s |

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
| `waiting_for_human` | `open` | 🟢 green | `●` | **PR** |
| `waiting_for_human` | `merged` | 🟣 purple | `●` | **PR** |
| `waiting_for_human` | `draft` / `closed` / `none` / unset | 🔴 red | `!` | **Needs you** |
| `idle` | `open` | 🟢 green | `●` | **PR** |
| `idle` | `merged` | 🟣 purple | `●` | **PR** |
| `idle` | `draft` / `closed` / `none` / unset | neutral | `○` | **Idle** |
| `done` | `open` | 🟢 green | `✓` | **Finished** |
| `done` | `merged` | 🟣 purple | `✓` | **Finished** |
| `done` | `draft` / `closed` / `none` / unset | neutral | `✓` | **Finished** |
| `exited` | `open` | 🟢 green | `×` | **Finished** |
| `exited` | `merged` | 🟣 purple | `×` | **Finished** |
| `exited` | `draft` / `closed` / `none` / unset | neutral, dimmed | `×` | **Finished** |

**Home bucket union (Phase 6, 6.6):** `"working" | "needs-you" | "idle" | "pr" | "finished"`.
The former single **Waiting** column is split into **Needs you** (`waiting_for_human`, red `!`) and
**Idle** (`idle`, neutral `○`) — mixing them under one "Waiting" label read as a bug (an idle
session sitting under "Waiting" with a neutral dot and no red `!`). Both are shown by default;
only **Finished** hides behind the `dashboard:showFinished` toggle — idle is still open work, not
done.

### Precedence — dot colour (D18, D21, B2)
```
1. done | exited                    → PR colour if any, else neutral   (D21)
2. working                          → "working"            🟡
3. not_started | spawning           → neutral, dashed       ◐          (B2)
4. pr = merged   (branch-matched)   → "pr-merged"          🟣
5. pr = open     (branch-matched)   → "pr-open"            🟢
6. waiting_for_human                → "waiting_for_human"  🔴
7. idle                             → "idle"                neutral
```
- `not_started`/`spawning` wins over any PR on the branch (B2, decided): a session
  that has not started has done nothing, so colouring it by a PR that already exists on
  the branch would misleadingly read as "landed and finished" for a session that never ran.
- `draft` and `closed` **never** drive colour or bucket — they are informational only.
- `working` beats PR on purpose: if you ask for more work on a branch that already has a PR, the
  in-progress signal is the more current fact.
- PR beats `waiting_for_human` on purpose: an agent idles at its prompt immediately after opening
  a PR, so red would otherwise mask blue permanently.

### Precedence — dashboard bucket (D19, split by 6.6)
```
1. done | exited        → Finished     (checked FIRST, unconditionally)
2. working | spawning   → Working
3. pr = open | merged   → PR
4. waiting_for_human    → Needs you
5. idle                 → Idle
6. otherwise            → Finished
```
- **Colour and bucket deliberately disagree for `done`/`exited`** (D21): the dot keeps the PR
  colour so you can see the branch landed, but the card stays in Finished, because `done` is an
  explicit manual user action meaning "I am finished with this". Do not "fix" this to agree.
- `idle` buckets to its own **Idle** column, not Finished — an idle session is open work, not
  done. Before Phase 6 this was merged with `waiting_for_human` into one "Waiting" column, which
  read as a bug (an idle session sitting under "Waiting" with a neutral dot and no red `!`).
  They're now separate columns: 🔴 **Needs you** (`waiting_for_human`, agent explicitly blocked)
  and neutral **Idle** (`idle`, nothing happening). Both are shown by default — only Finished
  hides behind "Show finished".

## Tokens

`web-ui/src/styles/tokens.css` — defined in **both** `[data-theme="dark"]` and
`[data-theme="light"]` blocks. Never a bare hex in a component or another stylesheet.

| Token | dark | light |
|---|---|---|
| `--status-working` | `#eab308` | `#a16207` |
| `--status-waiting` | `#ef4444` | `#dc2626` |
| `--pr-open` | `#22c55e` | `#15803d` |
| `--pr-merged` | `#8250df` | `#6e40c9` |
| `--pr-draft` | `#8a8a8a` | `#737373` |
| `--pr-closed` | `#6b6b6b` | `#737373` |

- Per-theme is mandatory: a single hex fails light-mode contrast (dark-theme `#22c55e` on white ≈
  2.1:1 vs the ≥3:1 bar for non-text UI).
- Non-colour cues that must survive any recolour: `tile--spawning { border-style: dashed }`,
  `tile--exited { opacity: .9 }`.

## Where each surface reads from

| Surface | File | Notes |
|---|---|---|
| Sidebar rows | `LeftSidebar.tsx` (4 `<StatusDot>` sites) | worktree rows roll up per worktree; the sidebar's session rows are both direct-session sites, hardcoded to `pr={null}` — a direct session never has a worktree to show a PR for |
| Dashboard cards | `DashboardPanel.tsx` | one card per non-archived agent session (Phase 6) — worktree-attached and direct alike, no rollup |
| Canvas tile border | `WorkspaceCanvas.tsx` | gated on the `showAgentStatusBorders` setting; per-session (`sessionStatus(session.state)` + a per-tile branch-guarded `session.pr`), not rolled up |
| Agent pane border | `AgentPaneSlot.tsx` | single session, so no rollup |
| VCS panel PR pill | `workspace.css` `.vcs-pr--*` | must use the same `--pr-*` tokens |

## Per-session vs per-worktree

- The **dot** is always per session.
- **The dashboard is per-session for LIFECYCLE, but per-worktree for PR** (Phase 6 amendment,
  2026-08-17; PR resolution corrected 2026-08-17 — BLOCKING-2). Every non-archived agent session
  (`type === "agent" && archivedAt == null`) gets its own card, bucketed by its own lifecycle
  status (`bucketForRollup`) — worktree-attached and direct alike. This replaces an earlier
  per-worktree rollup that picked one "winning" session's status for the whole worktree; that
  rollup shipped a real bug (`966b676`): one session's `waiting_for_human` (rank 8) hid a
  sibling's `working` (rank 6) for the entire worktree, patched at the time with a
  `hasLiveActivity` short-circuit. Both the rollup and the patch are gone from
  `DashboardPanel.tsx` — per-session cards make that class of bug structurally impossible, since
  each session always gets its own card in its own column.
  - **PR is a property of the BRANCH, not the session, and the daemon only ever writes it to
    ONE session.** `prPoller.ts` writes `SessionRecord.pr` exclusively to a worktree's `isMain`
    session — nothing else in the daemon ever writes it, so a sibling (non-main) session's own
    `.pr` field is always empty. The UI resolves the PR **per worktree** — `worktreePrStatus()`
    (`web-ui/src/lib/statusColor.ts`, not `worktreeStatus.ts`) reads the `isMain` session's `pr`
    and branch-guards it against the worktree's CURRENT branch (D20) — then fans that single
    resolved value out to every non-archived agent session card belonging to that worktree. This
    is "one write, N reads": the daemon never fans out the write itself (that would reintroduce
    write amplification), but every session card of a multi-agent worktree still shows the
    branch's PR colour/bucket. This is intentional duplication, not a bug (user decision, Phase 6
    amendment): a worktree is normally single-agent, so this only shows up in the rare multi-agent
    case, and every session showing the branch's real outcome is more truthful than picking a
    "winner" to hide behind.
  - A direct (worktree-less) session has no worktree to resolve a PR against, so it can **never**
    show a PR — its card is always lifecycle-only, regardless of what `session.pr` holds.
  - Archived sessions (`archivedAt != null`) produce no card at all.
  - **Which session holds `isMain` for a worktree can change at runtime** (main-session
    promotion — `DELETE /sessions/:id` on the main session promotes an eligible sibling to
    `isMain` before deleting the old main, `daemon/src/routes/sessions.ts`). This does not weaken
    the invariant above: at every instant exactly one session is `isMain` and `prPoller`/
    `worktreePrStatus()` still read/write only that one — promotion just means "that one" can be a
    different session than a moment ago. The promotion itself carries the old main's `pr` forward
    onto the promoted session in the same atomic step, so there is no gap where the worktree's PR
    colour blanks while waiting for the next poll tick.
- **The sidebar's worktree rows roll up per worktree** (unchanged by Phase 6) — see
  `worktreeRolledUpStatus()` in `web-ui/src/lib/worktreeStatus.ts`, used by `LeftSidebar.tsx`'s
  worktree-row `<StatusDot>` sites. There, the rolled-up worktree PR colour comes from
  `worktreePrStatus()` (`web-ui/src/lib/statusColor.ts`), which reads the **`isMain`** session
  only, matching the session `prPoller` writes to (K9). The sidebar's *session* rows, by contrast,
  are both direct-session sites and are hardcoded to `pr={null}` — see the surface table above.
  - `WorkspaceCanvas.tsx`'s tile border and `AgentPaneSlot.tsx`'s pane border are per-session for
    LIFECYCLE (each reads its own `session.state`), but per-worktree for PR, same as the
    dashboard: both resolve the tile's/pane's worktree PR via `worktreePrStatus()` — never a
    sibling session's own `session.pr` directly — and branch-guard it against that worktree's
    current branch before applying it to the tile/pane border.

## Testing without a daemon

Press **Ctrl+Shift+D** in the web UI for the dev state simulator
(`web-ui/src/components/dev/DevStatePanel.tsx`). It drives both axes and patches the client
stores directly, so no GitHub, no daemon writes, no restart. It sets `prBranch` to the session's
real worktree branch automatically — otherwise the branch guard filters the PR out and nothing
renders.
