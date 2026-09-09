# Review Findings — revisit-bar-mobile (d2ed88a)

## Verdict: PASS WITH MINOR NOTES

No critical regressions. Three minor housekeeping notes.

---

## Issues Found

### Minor 1 — Dead prop `leftColumnPx` in `TopBarProps` (TopBar.tsx:63)

The prop is still declared as optional in the interface (`leftColumnPx?: number`) but was removed from the destructuring and is no longer used inside the function. `Workspace.tsx` still passes it at lines 608 and 640. TypeScript won't error because the prop is optional and declared in the interface — callers just silently send an ignored value. No runtime impact, but it's misleading dead surface area.

**Fix needed:** Remove `leftColumnPx?: number` from `TopBarProps` and remove the two pass-sites in `Workspace.tsx`. (Or, if the property is expected to be used again soon, add a `// TODO` comment.)

### Minor 2 — Dead CSS `.top-bar--desktop .top-bar__brand` (workspace.css:1404)

This rule was added to limit brand height on desktop, but the `.top-bar__brand` element only exists in the login render path, which uses plain `.top-bar` (no `--desktop` modifier). The rule is never matched in the non-login desktop path. Harmless but dead.

**Fix needed:** Remove `.top-bar--desktop .top-bar__brand { height: 28px; }` (two lines).

### Minor 3 — Dead CSS `.top-bar__mobile-wt-row` (workspace.css:1451)

The `top-bar__mobile-wt-row` element was removed from `TopBar.tsx` but its CSS selector remains. Harmless.

**Fix needed:** Delete the `.top-bar__mobile-wt-row` rule block from `workspace.css`.

---

## Confirmed Correct

### Item 1 — Top bar height (`top-bar--desktop`)
`<header className={...top-bar--desktop...}>` is applied when `!isMobile` (TopBar.tsx:200). CSS rule `.top-bar--desktop .top-bar__row { padding: 4px var(--space-3); }` exists (workspace.css:1400). Class is on the correct element. ✓

### Item 2 — Sidebar Home (both mobile and desktop)
The `<Link to="/" className="left-sidebar__nav-item">` is now inside the `<div ref={scrollRef}` wrapper unconditionally — no longer guarded by `isMobile`. Collapsed state shows "VSH". CSS for `left-sidebar__nav-item` and `left-sidebar--collapsed .left-sidebar__nav-item` both exist (workspace.css:424, 446). The old desktop brand `<Link className="top-bar__brand">` and the `Logo` import are fully removed from TopBar.tsx. Logo import also correctly removed from LeftSidebar.tsx. ✓

### Item 3 — Traffic lights / macOS clearance
Toggle button (`PanelLeft`) is still the first element in `.top-bar__row`. macOS clearance is on the `<header>` itself: `body[data-tauri-os="macos"] .top-bar { padding-left: 80px }` (workspace.css:5054–5055). Removing the brand Link from the row does not affect this — the button stays inside the cleared zone. No broken layout from brand removal. ✓

### Item 4 — Mobile breadcrumb cleanup
`top-bar__mobile-wt-row` and its two child `<span>` elements (worktree id, branch) are removed from TopBar.tsx. The workspace-mode else-branch on mobile now renders only the project name: `<span className="top-bar__crumb-seg top-bar__mobile-line">{project?.name ?? "—"}</span>` (TopBar.tsx:253). The `mobileTitle` still includes `wt.id wt.branch` for the `title` attribute (tooltip), which is correct. ✓

### Item 5 — Worktree ID in popup (`wt-menu__info-row`)
`<div className="wt-menu__info-row">` is placed inside the portal `<div>` at LeftSidebar.tsx:1917, immediately before the first `<button>` at line 1921. CSS classes `wt-menu__info-row`, `wt-menu__info-label`, and `wt-menu__info-value` are all defined in workspace.css (lines 1408–1439) with correct flex layout, border-bottom separator, mono font for the value, and `user-select: text`. ✓

### Item 6 — Vertical split default on mobile
`toolSplitOrientationUserSet?: boolean` is correctly optional in `WorktreeLayout` (useStore.ts:32) and absent from `DEFAULT_WORKTREE_LAYOUT`, so it defaults to `undefined → false`. `effectiveOrientation` is computed correctly: `!toolSplitOrientationUserSet && isMobile ? "vertical" : toolSplitOrientation` (Layout.tsx:68–69). The `toggleToolSplitOrientation` action stamps `toolSplitOrientationUserSet: true` on toggle (useStore.ts:659). `effectiveOrientation` drives both `direction=` and `autoSaveId=` on `PanelGroup` (Layout.tsx:243–244), so panel sizes are correctly bucketed per orientation. On desktop `effectiveOrientation === toolSplitOrientation` always, so existing desktop saved panel sizes are unaffected. ✓

### TypeScript cleanliness
- `useEffect`, `useRef`, `useState` removed from TopBar.tsx imports together with the brand measurement code that used them. ✓
- `Link` removed from TopBar.tsx imports; no Link calls remain in TopBar (login banner uses `<span>`, not `<Link>`). ✓
- `useWorkspaceStore` / `clearWorkspaceSelection` removed from TopBar.tsx; all their usage sites were deleted. ✓
- `Logo` import kept in TopBar.tsx and still used at line 168 (login banner). ✓
- `Logo` import removed from LeftSidebar.tsx; not used in new LeftSidebar code. ✓
