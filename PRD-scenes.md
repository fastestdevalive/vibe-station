# PRD — Scenes (multi-session layouts)

Status: Draft / brainstorm · Owner: @beebom786 · Branch: `revisit-layout`

> Very small PRD to collect requirements and shape direction. Not a build spec yet.

## 1. Why
The workspace today shows **one worktree** at a time. As people run many agents
across worktrees/projects, they want to compose a **single screen of several
sessions** — watch them progress, and jump in when one needs input — and recall
that arrangement later. A **Scene** is a saved, named, multi-tile layout of
sessions (and other panes) drawn from anywhere.

## 2. Concept
A **Scene** = a named grid of **tiles**; each tile renders one pane (an agent
session, a terminal, or a tool view) bound to a specific worktree. Switching to
a scene lays out all its tiles at once. Example — *"Release push"*: main agents
of 3 worktrees + a shared terminal, in a 2×2.

## 3. Requirements captured (this round)

| Dimension | Decision |
|-----------|----------|
| **Primary goal** | **Monitor + occasionally intervene** — all tiles stream live; click a tile to focus and type, others keep running. |
| **Layout** | **Grid presets** (2×2, 1+2, 3-col, …) — sessions drop into slots; predictable and easy to persist. |
| **Tile contents** | **Any pane** — agent session, terminal, or a tool (browser / preview / devices / artifacts). |
| **Persistence** | **On the daemon** — scenes are *user customizations*, so they live server-side and follow the user across devices (Tailscale/remote). |

## 4. Direction: user-scoped customizations
Scenes are the first of a broader class of **user customizations** (alongside
layout prefs, modes, etc.) that should eventually live under a **user model** on
the daemon. For now: store scenes on the daemon under a single implicit user,
but shape the data/API so it can be **namespaced per user** later without a
migration headache (e.g. `users/<id>/scenes` from day one, defaulting to a
`local` user).

## 5. Tile model (sketch)
A tile references *what to show* + *where it lives*:
```
Tile {
  id
  kind: "agent" | "terminal" | "browser" | "preview" | "devices" | "artifacts"
  worktreeId            // which worktree this pane belongs to
  sessionId?            // for agent/terminal tiles (or "main" / by-slot)
  // tool tiles (browser/preview/...) may carry their own small config later
}
Scene {
  id, name
  preset: "2x2" | "1+2" | "3col" | ...   // grid template
  tiles: Tile[]                          // positional → slots fill in order
}
```

## 6. Interaction (monitor + intervene)
- Every visible tile streams live (multiple agent PTYs at once).
- One tile is **focused** (click) — keystrokes go there; a clear focus ring.
- A scene **switcher** (top bar / command palette) flips between saved scenes.
- Build/edit a scene from currently open sessions ("Save current as scene") or
  by adding tiles from a picker.

## 7. Rough layout
```
┌──────────────────────────────────────────────┐
│ TopBar   Scene: [ Release push ▼ ]  + new     │
├──────┬───────────────────────────────────────┤
│ Nav  │ ┌─────────────┐ ┌─────────────┐        │
│ rail │ │ wt-12 · main│ │ wt-09 · main│        │
│      │ │  (agent)    │ │  (agent)    │        │
│      │ ├─────────────┤ ├─────────────┤        │
│      │ │ wt-12 · term│ │ wt-09 ·brows│        │
│      │ └─────────────┘ └─────────────┘        │
└──────┴───────────────────────────────────────┘
   focused tile has a highlight ring; others stream live
```

## 8. Open questions (brainstorm)
1. **Scope** — can one scene mix tiles from **different projects**, or is a
   scene project-scoped? (assume cross-project for now)
2. **Relationship to the normal workspace** — is "Scenes" a separate top-level
   **mode** (like Dashboard) you switch into, or does it replace the center
   region? Does selecting a scene change the "active worktree", or are tiles
   independent of it?
3. **Cross-worktree tiles** — a Files/preview tile is tied to one worktree; a
   browser tile may not be. Confirm every tile carries its own `worktreeId`.
4. **Stale references** — scene references an exited session or a deleted
   worktree: show a "session ended / resume" tile, auto-heal to the worktree's
   main session, or drop the tile?
5. **Performance** — N live agent PTYs streaming at once: cap tiles per scene?
   pause/throttle off-focus tiles? (xterm + WS load)
6. **Mobile** — grid → vertical stack? scenes desktop-only?
7. **Creation UX** — "save current workspace as scene" vs. an explicit builder.

## 9. Phasing (proposed)
- **P0 (this is just the PRD).**
- **P1** — daemon scene CRUD (user-namespaced, default `local` user) + a
  read-only scene **view** with grid presets and agent/terminal tiles.
- **P2** — focus/intervene interaction, "save current as scene", scene switcher.
- **P3** — tool tiles (browser/preview/devices/artifacts), free-form sizing,
  real multi-user model.

## 10. Out of scope (for now)
Real multi-user auth/identity, sharing scenes between users, free-form drag
layouts, cross-machine session migration.
