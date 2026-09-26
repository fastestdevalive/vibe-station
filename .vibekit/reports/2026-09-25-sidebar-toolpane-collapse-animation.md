# SDLC report: tools-pane-ui-polish

**Date:** 2026-09-25 · **Commit:** 5a1dcb6c · **Sub-feature(s) covered:** root (ad hoc, no formal sdlc state for this feature)

## Bugs
| # | Symptom | Where found | Severity |
|---|---------|-------------|----------|
| 1 | Global left sidebar collapse/expand snaps instantly — no slide/shift animation, unlike the Files tool's left pane | Manual UI review, this session | Minor (UX polish/consistency) |
| 2 | Tool pane (the right global panel) collapse/expand also snaps instantly, same gap | Manual UI review, this session | Minor (UX polish/consistency) |

## Root cause
- `Files-left-pane-animates` → `FilesPanel.tsx` (`.files-panel__content`) — the tree/search overlay isn't a real layout sibling; the preview pane is a full-width flex child whose `paddingLeft` is animated via a hand-rolled `transition: padding-left 0.15s ease` (disabled during live drag via `isDragging`). The "shift" is simulated padding, and that's the one place a CSS transition was actually added.
- `Sidebar-and-toolpane-snap` → `Layout.tsx` — both the global left sidebar (`.pane-left`) and the tool pane are genuine `react-resizable-panels` `Panel` siblings with `collapsedSize={0}`, toggled imperatively via `toolsPanelRef.current?.collapse()`/`.expand()` (and the sidebar's equivalent ref). This already reflows the *adjacent* content correctly (real flexbox, not padding tricks) — but `react-resizable-panels` sets the collapsed/expanded size via inline style with no transition of its own, so the correct reflow happens with zero animation.
- Net effect: two unrelated mechanisms for "shrink a pane to make room" exist in the codebase today — Files' manual padding-transition (animated) vs. `react-resizable-panels`' imperative collapse (unanimated) — and the sidebar/tool-pane both use the second one.

## Action items
| # | Action | Owner sub-feature | Status |
|---|--------|--------------------|--------|
| 1 | Add a CSS transition on the resized property of the sidebar's and tool-pane's `Panel` wrapper elements (targeting whatever `react-resizable-panels` sets inline — typically `flex-basis`/width on the panel's own rendered div), scoped so it only applies on toggle, not on live drag (reuse each panel's own drag-active flag/attribute the same way `FilesPanel.tsx` already guards its transition with `isDragging`) | new bundle ("sidebar/toolpane collapse animation") | open |
| 2 | Verify the transition doesn't fight `react-resizable-panels`' own resize-observer/layout math — test drag-resize immediately after a collapse/expand animation completes, and test rapid double-toggling | same | open |
| 3 | Decide whether to also animate the *adjacent* pane's flex-grow reflow (agent pane / main content expanding into the freed space) or leave that to the browser's default flex reflow — likely fine as-is since flex transitions on `flex-grow`/width read smoothly in most browsers when the sibling's basis is also transitioning | same | open |
| 4 | (Rejected as first choice, noted for completeness) Replacing `collapsedSize`/imperative collapse entirely with Files' manual overlay+padding-transition approach would also work and matches existing precedent more closely, but is a larger change (drops `react-resizable-panels`' collapse API for these two panels) for the same visual outcome — prefer action item 1 unless it proves fragile in practice | same | open |

## Diagrams
```mermaid
flowchart LR
    subgraph Files["Files left pane (already animated)"]
        A["Tree/Search overlay\n(position: absolute)"] -->|toggled| B["preview pane paddingLeft\ntransition: padding-left .15s ease\n(off during drag)"]
    end
    subgraph Panels["Sidebar + Tool pane (not animated today)"]
        C["react-resizable-panels Panel\ncollapsedSize: 0"] -->|imperative .collapse()/.expand()| D["inline flex-basis/width\nset with NO transition"]
    end
    E["Fix: add CSS transition to the\nPanel's sized property,\noff during live drag"] --> D
```
