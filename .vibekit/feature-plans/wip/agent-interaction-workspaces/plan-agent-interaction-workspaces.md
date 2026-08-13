---
PRD: prd-agent-interaction-workspaces.md
Status: WIP
---

<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: Agent Interaction State + Workspaces (v5 — thin master)

> Exactly two sub-feature plans, split along the boundary the user actually asked for: **(1) interaction states** — the `waiting_for_human`/`needs_review` daemon lifecycle-state machine and everything that surfaces it — and **(2) Workspaces** — the entire tiled-canvas feature (shipped implementation, shipped cursor/border fixes, in-flight detachment, in-flight spawn-affinity), all as phases of one coherent plan. This root plan carries no implementation checklist of its own — see Sub-Plan Breakdown.

**Issue:** agent-interaction-workspaces
**Branch:** `introducing-new-state` (current)
**Status:** WIP
**PRD:** `.vibekit/feature-plans/wip/agent-interaction-workspaces/prd-agent-interaction-workspaces.md`

---

## Revision note (v5 — this restructure)

- **Why:** user feedback on v4 — *"Why do we still have 1 and 2. I clearly said let's just have 2 plans. We don't need 4."*
- **What changed:** v4 still carried 4 sub-feature plan files (`01-workspace-detachment`, `02-source-agent-spawn`, `03-interaction-states`, `04-workspaces`) even though `04-workspaces` already pointed at `01`/`02` via a Sub-Plan Breakdown table. This revision **merges `01-workspace-detachment` and `02-source-agent-spawn` directly into `04-workspaces`** as new phases (Phase 3 — workspace detachment, Phase 4 — source-agent spawn affinity), deletes both directories, and removes `04-workspaces`'s Sub-Plan Breakdown table (no sub-plans left to index). The feature is now exactly **two** sub-feature plans:
  - [`03-interaction-states`](./03-interaction-states/plan-03-agent-interaction-workspaces-interaction-states.md) — unchanged, still the `waiting_for_human`/`needs_review` daemon lifecycle-state machine.
  - [`04-workspaces`](./04-workspaces/plan-04-agent-interaction-workspaces-workspaces.md) — now a single plan covering all of Workspaces: shipped canvas/tiling (Phase 1), shipped cursor/border fixes (Phase 2), workspace detachment (Phase 3, absorbs former `01-workspace-detachment`), source-agent spawn affinity (Phase 4, absorbs former `02-source-agent-spawn`).
- **Numbering:** `01-workspace-detachment`/`02-source-agent-spawn` directories are deleted outright, not kept as empty/stub dirs — their content lives on as `04-workspaces`'s Phase 3/Phase 4 (sub-phases 3a/3b/3c and 4a/4b/4c). No new `NN` is assigned to anything by this revision.
- **No content lost:** every requirement ID (R1-R9/R3a, W1-W12, L1-L8, D1-D8, S1-S6), every CUJ, every Key Decision, every Risk/Open Question, every Files & Phase Impact row from the two deleted sub-plans is now inside `04-workspaces` — verified by ID-traceability grep across the two remaining sub-feature plans.
- **v4 / v3 / v2 / v1 history:** see the prior revision notes preserved in the PRD (`prd-agent-interaction-workspaces.md` §Revision note) — not repeated here to avoid re-deriving content that already has a canonical home.

---

## Problem

- See [prd-agent-interaction-workspaces.md](./prd-agent-interaction-workspaces.md) §Problem — no way to tell "idle" from "blocked on a human" or "PR ready for review" today, and the layout can't show multiple agents at once.

## Concept

- See [prd-agent-interaction-workspaces.md](./prd-agent-interaction-workspaces.md) §1-§5 for full behavior + state machine + color mapping + tiling model + detachment + spawn affinity.
- This root plan makes no implementation decisions of its own — every requirement is owned by exactly one of the two sub-feature plans below (or their own nested sub-plans).

---

## Priority & sequencing

| Order | Sub-feature | Depends on |
|-------|-------------|------------|
| 1 | [`03-interaction-states`](./03-interaction-states/plan-03-agent-interaction-workspaces-interaction-states.md) — `waiting_for_human` + `needs_review` state machine (daemon `LifecycleState`, JSON-channel detection, PR poller, WS broadcast, rollup/`StatusDot`) | none |
| 2 | [`04-workspaces`](./04-workspaces/plan-04-agent-interaction-workspaces-workspaces.md) — live-pane tiles, free-form + tiling layout modes, color mapping (Phase 1, shipped); cursor/border fixes (Phase 2, shipped); workspace detachment (Phase 3, in-flight); source-agent spawn affinity (Phase 4, in-flight) | Consumes `03-interaction-states`'s color mapping for tile/pane coloring, but is not blocked by it — the canvas already renders correctly for the 5 states that exist today; `waiting_for_human`/`needs_review` colors activate automatically once `03` ships (shared `sessionStatus()` helper, no Workspaces-side change needed) |

- Within `04-workspaces`: Phase 3 (detachment) should land before/alongside Phase 4 (spawn affinity) since spawn-affinity's workspace-scan logic is simpler once workspaces are a flat global list — see `04-workspaces`'s own Concept section.

---

## Sub-Plan Breakdown

| Sub-plan | Origin | Scope |
|----------|--------|-------|
| [`03-interaction-states`](./03-interaction-states/plan-03-agent-interaction-workspaces-interaction-states.md) | planned (relocated from this plan's former Phase 1/1b/2, v4 restructure) | `waiting_for_human`/`needs_review` daemon lifecycle-state machine + rollup/`StatusDot` surfacing. PRD §1 (R1-R9). Not yet implemented on the daemon side. |
| [`04-workspaces`](./04-workspaces/plan-04-agent-interaction-workspaces-workspaces.md) | planned (relocated from this plan's former Phase 3/4, v4 restructure; absorbed former `01-workspace-detachment`/`02-source-agent-spawn` as Phase 3/4, v5 restructure) | Entire Workspaces feature as one plan: shipped canvas/tiling/chrome implementation (Phase 1), shipped cursor+border fixes (Phase 2), workspace detachment (Phase 3, PRD §4 D1-D8), source-agent spawn affinity (Phase 4, PRD §5 S1-S6). |

- `NN` (`03`, `04`) assigned once, never renumbered. `01`/`02` (formerly `01-workspace-detachment`/`02-source-agent-spawn`) were deleted in the v5 restructure — their content lives on inside `04-workspaces`'s Phase 3/Phase 4, not as separate `NN` directories.
- **Master/root exception:** this plan replaces its own Files & Phase Impact table with this Sub-Plan Breakdown table per the planning skill's convention for a root plan with a populated breakdown — see `SECTIONS.md` "Master/root exception." No file is modified directly by this root plan; every file touched by this feature is owned by one of the two sub-feature plans above (or their nested sub-plans).

---

## Files & Phase Impact

See Sub-Plan Breakdown above — this root plan has no checklist or files of its own.
