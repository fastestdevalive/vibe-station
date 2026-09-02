# Storage Management UI — Visual PRD

**Feature:** Settings → Storage Management  
**Status:** Draft / Pre-implementation  
**Scope:** Read worktree disk usage, surface device capacity, allow selective deletion of `done` worktrees. Also removes the "dismiss (keep files)" worktree action.

---

## 0. Settings panel — layout change (prerequisite)

Before adding Storage, the desktop settings layout needs to change. Here is the current state and what it becomes.

### Current desktop layout (scroll-to-anchor)

The left nav has 4 items. Clicking one calls `scrollIntoView` — it does **not** hide other sections. All sections are always rendered stacked in a single scrollable column.

```
+--------------------------------------------------------------------+
|  Settings                                                           |
|  +--------------+--------------------------------------------+     |
|  | Settings     |  MODES                                     |     |
|  |              |  +----------------------------------------+|     |
|  |  Modes       |  |  ... ModesSetting card ...             ||     |
|  |  Appearance  |  +----------------------------------------+|     |
|  |  Projects    |                                             |     |
|  |  Hidden      |  APPEARANCE                                 |     |
|  |  projects    |  +----------------------------------------+|     |
|  |              |  |  ... AppearanceSetting card ...        ||     |
|  |              |  +----------------------------------------+|     |
|  |              |                                             |     |
|  |              |  PROJECTS                                   |     |
|  |              |  +----------------------------------------+|     |
|  |              |  |  ... ProjectsSetting card ...          ||     |
|  |              |  +----------------------------------------+|     |
|  |              |                                             |     |
|  |              |  HIDDEN PROJECTS                            |     |
|  |              |  +----------------------------------------+|     |
|  |              |  |  ... HiddenProjectsSetting card ...    ||     |
|  |              |  +----------------------------------------+|     |
|  |              |                                             |     |
|  |              |  v  (keep scrolling...)                    |     |
|  +--------------+--------------------------------------------+     |
+--------------------------------------------------------------------+
```

**Problem:** Adding Storage would append a 5th card to an already-tall scroll.
Storage needs full panel height for its own toolbar + list + footer — it cannot
work as a card wedged at the bottom.

---

### Proposed desktop layout (section switcher)

The left nav becomes a true section switcher — clicking a nav item sets
`activeSection` state and renders **only that section's content** in the right
column. The active item gets a filled background pill highlight. This is the
same pattern mobile already uses (underline tabs, one section at a time).

```
+--------------------------------------------------------------------+
|  Settings                                                           |
|  +--------------+--------------------------------------------+     |
|  | Settings     |                                             |     |
|  |              |  Modes                                      |     |
|  |  Modes       |  +----------------------------------------+|     |
|  |  Appearance  |  |                                        ||     |
|  |  Projects    |  |  ... ModesSetting content ...          ||     |
|  |  Hidden      |  |                                        ||     |
|  |  projects    |  +----------------------------------------+|     |
|  |> Storage <   |                                             |     |
|  |              |                                             |     |
|  +--------------+--------------------------------------------+     |
+--------------------------------------------------------------------+

                   (click Storage in nav ->)

+--------------------------------------------------------------------+
|  Settings                                                           |
|  +--------------+--------------------------------------------+     |
|  | Settings     |                                             |     |
|  |              |  Storage                                    |     |
|  |  Modes       |  +----------------------------------------+|     |
|  |  Appearance  |  |  ... StorageSetting (full height) ...  ||     |
|  |  Projects    |  |                                        ||     |
|  |  Hidden      |  |                                        ||     |
|  |  projects    |  +----------------------------------------+|     |
|  |> Storage <   |                                             |     |
|  |              |                                             |     |
|  +--------------+--------------------------------------------+     |
+--------------------------------------------------------------------+
```

`> Storage <` denotes the active nav item with a filled background pill.
All other nav items are plain text buttons as they are today.

**Mobile** is unchanged — it already uses the underline tab switcher, and
Storage simply becomes the 5th tab there.

---

## 1. Entry point

Storage is a new item in the left settings nav — fifth after Hidden projects.
No separate dialog or route needed; it renders in the same right-hand content
area as every other section.

---

## 2. Full layout — Settings panel with Storage active

The outer chrome is the settings panel with the new section-switcher nav.
The right column is where `StorageSetting` fills the full available height.

```
+------------------------------------------------------------------------------+
|  Settings                                                                     |
|  +----------------+----------------------------------------------------------+|
|  | Settings       |  Storage                                                  ||
|  |                |                                                            ||
|  |  Modes         |  +------------------------------------------------------+ ||
|  |  Appearance    |  |  Device disk                                          | ||
|  |  Projects      |  |  ####################.......  52.3 GB / 100 GB       | ||
|  |  Hidden        |  |  47.7 GB free                                         | ||
|  |  projects      |  +------------------------------------------------------+ ||
|  |                |                                                            ||
|  |> Storage <     |  Worktrees  ──────────────────────────────────────────── ||
|  |                |                                                            ||
|  |                |  [ ] Select all   Sort: Creation date v   Show: Done v   ||
|  |                |                                                            ||
|  |                |  +- - - - - - - - - - - - - - - - - - - - - - - - - -+  ||
|  |                |  |[v] vs-72 · management-ui-option      * done        |  ||
|  |                |  |    Created Sep 2, 2026                              |  ||
|  |                |  |    ####.....  1.2 GB                           [x] |  ||
|  |                |  +- - - - - - - - - - - - - - - - - - - - - - - - - -+  ||
|  |                |  +- - - - - - - - - - - - - - - - - - - - - - - - - -+  ||
|  |                |  |[v] vs-68 · refactor/auth-middleware  * done        |  ||
|  |                |  |    Created Aug 28, 2026                             |  ||
|  |                |  |    #########  2.8 GB                           [x] |  ||
|  |                |  +- - - - - - - - - - - - - - - - - - - - - - - - - -+  ||
|  |                |  2 done worktrees shown  (2 others hidden by filter)      ||
|  |                |                                                            ||
|  |                |  ──────────────────────────────────────────────────────  ||
|  |                |  2 selected (4.0 GB)              [ Delete selected [x] ] ||
|  +----------------+----------------------------------------------------------+|
+------------------------------------------------------------------------------+
```

(# = filled bar, . = empty bar, * = status dot, [x] = delete icon, [v] = checked checkbox)

**Default filter is "Done"** — only `done` worktrees are shown on first open.
The hint line below the list (`2 others hidden by filter`) tells the user that
active worktrees exist but are filtered out, so the empty-looking list is not
confusing.

**Mobile** — Storage becomes the 5th tab (unchanged underline tab pattern):

```
+-------------------------------------------------------------+
|  Modes  Appearance  Projects  Hidden  Storage               |
|                                       ------                |
|  ... StorageSetting content ...                             |
+-------------------------------------------------------------+
```

---

## 3. Controls bar

```
[ ] Select all     Sort: Creation date v     Show: Done v
```

Three controls, left to right:

| Control | Default | Options |
|---------|---------|---------|
| Select all checkbox | unchecked | checks all visible (filtered) rows |
| Sort dropdown | Creation date (newest first) | Creation date / Disk usage (largest first) |
| Show (filter) dropdown | Done | Done / All |

### Show dropdown detail

```
Show: Done v
  +-----------+
  | > Done    |   only worktrees whose all sessions are lifecycle=done (default)
  |   All     |   every worktree regardless of status
  +-----------+
```

When "All" is selected, non-done rows are shown but their checkboxes and delete
icons remain disabled (same rules as before). The controls bar summary count
updates to reflect the full list: `4 worktrees · 3.1 GB`.

---

## 4. Row anatomy

```
+---------------------------------------------------------------+
|  [v]  vs-72 · management-ui-option             * done         |
|        Created Sep 2, 2026 · 3 sessions                       |
|        ####.....  1.2 GB                               [x]    |
+---------------------------------------------------------------+

[v]         checkbox — only enabled when all sessions = done
vs-72       worktree id
branch      branch the worktree is on
* done      status dot (reuses existing StatusDot colours/glyphs)
Created     absolute creation date + session count
####....    mini bar: this worktree / largest worktree in the list
1.2 GB      disk used by git checkout + daemon data dir
[x]         per-row delete (done only); greyed [/] + tooltip if not deletable
```

### Status rules for checkbox and delete icon

| Lifecycle state | Checkbox | Per-row delete |
|----------------|----------|----------------|
| `done` | enabled | active |
| anything else | disabled | greyed, tooltip: "Only done worktrees can be deleted" |

---

## 5. Sort options

```
Sort: Creation date v
  +------------------+
  | > Creation date  |   newest first (default)
  |   Disk usage     |   largest first
  +------------------+
```

---

## 6. Bulk delete confirmation dialog

Triggered by "Delete selected" or the per-row delete icon.

```
+------------------------------------------------------+
|  Delete 2 worktrees?                                  |
|                                                        |
|  This will permanently remove:                         |
|                                                        |
|  * vs-72 · management-ui-option       (1.2 GB)        |
|  * vs-68 · refactor/auth-middleware   (2.8 GB)        |
|                                                        |
|  Total freed: 4.0 GB                                   |
|                                                        |
|  This cannot be undone.                                |
|                                                        |
|                [ Cancel ]  [ Delete worktrees [x] ]   |
+------------------------------------------------------+
```

If the daemon guard fires mid-flight (a session woke up between confirm and
the request), an inline error banner replaces the button row:

```
|  ! vs-72 is no longer done — deletion cancelled.      |
|                                         [ Close ]      |
```

---

## 7. Empty / loading states

**Loading (disk usage calculating):**
```
  Calculating disk usage...  (spinner)
```

**Filter = Done, but no done worktrees yet:**
```
  No done worktrees.
  Worktrees appear here once you mark a session done,
  or switch the filter to All to see active ones.
```

**No worktrees at all:**
```
  No worktrees yet.
  Worktrees appear here once you spawn an agent.
```

---

## 8. Daemon-side changes

### 8a. Delete guard

`DELETE /api/worktrees/:id` must refuse deletion if **any** session in the
worktree is not in lifecycle state `done`.

```
409 Conflict
{ "error": "worktree_not_done", "sessions": ["<id>", ...] }
```

### 8b. Remove "dismiss (keep files)"

The current worktree delete flow offers two variants:
- **Delete** — sends `DELETE /worktrees/:id?purge=true`, removes the git checkout and daemon records.
- **Dismiss (keep files)** — sends `DELETE /worktrees/:id` (no `purge`), removes daemon records only, leaves the checkout on disk.

"Dismiss (keep files)" is being removed entirely. Reasons:
- It leaves orphaned checkouts with no way to re-import them into vst.
- It creates a confusing half-deleted state (daemon has no record, disk has the files).
- The Storage UI's delete flow is the right place to manage disk; a soft-delete that doesn't free space defeats the purpose.

**Exact removal scope:**

| Layer | File | What to remove |
|-------|------|----------------|
| API client | `web-ui/src/api/client.ts` lines 337-343 | `dismissWorktree()` method |
| Mock API | `web-ui/src/api/mock.ts` lines 416-423 | `dismissWorktree()` mock |
| Dashboard | `web-ui/src/components/layout/DashboardPanel.tsx` lines 83, 218, 244, 262-273, 441-466 | `pendingDismiss` state, `showDismiss` logic, EyeOff button, ConfirmDialog |
| Sidebar | `web-ui/src/components/layout/LeftSidebar.tsx` lines 609, 765-776, 1859-1870, 1990-1997 | `pendingDismiss` state, `confirmDismissWorktree()`, both ConfirmDialogs, context menu item |
| Daemon route | `daemon/src/routes/worktrees.ts` lines 859-909 | `?purge` query param check; make `purge=true` the only behaviour (always call `worktreeRemove()`) |

After this change the `DELETE /worktrees/:id` route always purges — the `?purge` param is no longer read and can be removed from the handler.

---

## 9. Open questions

1. **What counts as "disk usage"?**  
   Candidate: `du -sh <worktree-checkout-path> + <daemon-data-dir-for-worktree>`.
   Should we include git objects shared with the base repo (hard-linked in some
   git worktree setups)? Probably show apparent size, not actual — simpler and
   matches what users expect "the folder weighs" to mean.

2. **Device disk bar scope**  
   Show the partition that `$VST_DATA_DIR` lives on, or always `/`?

3. **"Oldest first" sort direction**  
   Could just be a toggle arrow next to "Creation date" rather than a separate
   dropdown option — decide at implementation time.

4. **Per-project grouping**  
   Out of scope for v1, but a collapsed-by-project view could be useful later.
