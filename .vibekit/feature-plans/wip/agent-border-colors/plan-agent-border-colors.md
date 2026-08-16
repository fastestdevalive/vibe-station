# Plan: agent-border-colors

Small CSS-only fix, no PRD.

## Scope

Agent tile/pane border colors (canvas mode + classic single-agent pane) should only appear for
`waiting_for_human` and `needs_review` — every other status (`working`, `idle`, `done`, `exited`,
`spawning`, `none`) gets no colored border, just the neutral default. Separately: `needs_review`'s
color needs to stop reading as basically-the-same as `working`'s — switch it to green (distinct,
"PR" reads as a positive/actionable-but-not-urgent signal, matches user's suggestion).

## Root cause / findings

Two files each define an identical 6-rule block mapping session status → border color, kept in
sync by convention/comment only (`workspace-canvas.css` for canvas tiles, `chat.css` for the
classic single-agent pane — `AgentPaneSlot.tsx`), plus `StatusDot`'s own (separate, NOT in scope —
still needs the full status range for its glyph/dot) color rules in `workspace.css`:

- `.workspace-canvas__tile--waiting_for_human` / `.agent-pane-slot--waiting_for_human` → `#ef4444` (red) — keep, unchanged.
- `.workspace-canvas__tile--needs_review` / `.agent-pane-slot--needs_review` → `#b98cff` (light purple) — this and `working`'s `var(--accent)` (`#6e78c7`/`#5c64b5`, blue-purple) are different hex values but close enough in the blue/purple family to read as "the same color" at a glance on a thin border — confirmed as the user's complaint. Fix: change to `var(--success)` (`#16a34a`, already a defined token used elsewhere e.g. the dashboard's daemon-online dot) — safe now that `--done`'s border rule (also green, `#22c55e`) is being removed below, so no new collision.
- `.workspace-canvas__tile--working` / `.agent-pane-slot--working` → `var(--accent)` — **remove** (falls back to the base rule's neutral border: `var(--border-default)` for canvas tiles, `transparent` for the agent pane slot).
- `.workspace-canvas__tile--idle` / `.agent-pane-slot--idle` → **remove**, same fallback.
- `.workspace-canvas__tile--done` / `.agent-pane-slot--done` → **remove**, same fallback.
- `.workspace-canvas__tile--exited` / `.agent-pane-slot--exited` → **remove**, same fallback.
- `.workspace-canvas__tile--spawning` / `.agent-pane-slot--spawning` → **remove**, same fallback (this one already just aliased `--border-default` anyway — deleting it is a no-op change, included for consistency/one-rule-per-file-not-six).

No JS changes needed: `WorkspaceCanvas.tsx`/`AgentPaneSlot.tsx` will keep attaching the
status-suffixed class exactly as before (and the existing `showAgentStatusBorders` Settings
toggle keeps gating whether the class is attached at all) — removing the CSS rule is sufficient
to make a given status render with no color, since both base rules already define a neutral
default border.

## Checklist

- [x] 1. `web-ui/src/styles/workspace-canvas.css`: delete the `--working`/`--idle`/`--done`/`--exited`/`--spawning` rules; change `--needs_review`'s color to `var(--success)`; update the module comment above the block to reflect the new scope (2 statuses only).
- [x] 2. `web-ui/src/styles/chat.css`: same edits, mirrored exactly.
- [x] 3. Grep the repo once more for any other consumer of these border-color rules (there shouldn't be any beyond the two files above — `StatusDot`'s own colors in `workspace.css` are a separate, deliberately-untouched surface) to make sure nothing else needs updating.
- [x] 4. Update `AgentPaneSlot.test.tsx` / `WorkspaceCanvas.test.tsx` (or add cases) if either currently asserts a `--working`/`--idle`/`--done`/`--exited` border class's color contract — check first, only touch if something actually asserts on the removed rules.

## Verification

- `npx tsc -b --noEmit`, `npm run build`, `npx vitest run` (web-ui) — no logic changed, so this is
  mostly a "nothing broke" check; the real verification is visual.
- Visual: live dev sandbox (`vs-48`, already running at localhost:5182) — use the dev-only state
  simulator (`components/dev/DevStatePanel.tsx`) to force a session through each of the 7
  `SessionState` values and screenshot the canvas tile / classic agent pane border for each,
  confirming only `waiting_for_human` (red) and `needs_review` (green) show a colored border and
  everything else shows the neutral default.
