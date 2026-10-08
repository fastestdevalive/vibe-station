import { useViewportWidth, usePortalRoot, useEventTargets, useDemoEnv } from "../../context/DemoEnv";
import { Bot, Check, ChevronDown, ChevronRight, Eye, EyeOff, Filter, Folder, FolderOpen, FolderPlus, FolderTree, Github, Home, Keyboard, MoreHorizontal, Pin, Plus, Settings, Stethoscope, Trash2, Type, X } from "lucide-react";
import { ThemeQuickPicker } from "@/components/layout/ThemeQuickPicker";
import { useTheme } from "@/hooks/useTheme";
import { fuzzyScore } from "@/lib/fuzzyMatch";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import pkgJson from "../../../package.json";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ApiInstance } from "@/api";
import type { DraftConfig, Project, Session, SessionState, Worktree } from "@/api/types";
import { useDoctorStatus } from "@/hooks/useDoctorStatus";
import { useGlobalDraftStore } from "@/store/globalDraftStore";
import { computeNewSortOrder, useWorkspaceStore, type WorkspaceDoc } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { createProjectDirectDraft, createProjectWorktreeDraft } from "@/lib/projectDraft";
import { markOrderedListWrite, clearOrderedListWrite } from "@/hooks/useServerSync";
import { useLayout } from "@/hooks/useLayout";
import { useDragClickGuard } from "@/hooks/useDragClickGuard";
import { useSubscription, useWorktreeDiffStats } from "@/hooks/useSubscription";
import { StatusDot } from "@/components/layout/StatusDot";
import { ModeIcon } from "@/components/agent/ModeIcon";
import { useModeIcon } from "@/store/modesStore";
import { sessionModeId } from "@/lib/modeIcon";
import { Logo } from "@/components/shared/Logo";
import { worktreePrStatus } from "@/lib/statusColor";
import { worktreeRolledUpStatus, type WorktreeRolledUpStatus } from "@/lib/worktreeStatus";
import { sessionLabel, draftLabel, worktreeLabel } from "@/lib/sessionLabel";
import { pickNextDirectAgent } from "@/lib/sessionVisibility";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { HiddenWorktreesDialog } from "@/components/dialogs/HiddenWorktreesDialog";
import { CollapsedProjectRail } from "@/components/layout/CollapsedProjectRail";
import { ProjectPlusMenu } from "@/components/layout/ProjectPlusMenu";
import { clampPopupPosition } from "@/lib/popupPosition";

/** Material Design "search" glyph — a more natural glass-to-handle proportion than Lucide's. */
function MaterialSearchIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
    </svg>
  );
}


/**
 * Drag-reorder wrapper for a sidebar row (worktree or direct-session).
 *
 * Wraps the existing `.wt-row-wrap` div in place — no extra DOM node, no
 * change in React tree position/branch — only `transform`/`transition` CSS
 * moves during a drag. LeftSidebar never renders TerminalPane/ChatPane, so
 * there's no remount risk here at all, but keying strictly by row id (never
 * index) is kept as the same discipline used in TabsStrip's SortableTab.
 *
 * No dedicated drag handle: `attributes`/`listeners` are meant to be spread
 * onto the row itself (same approach as TabsStrip's SortableTab) so the whole
 * row is the drag surface — dragging it reorders, a plain click still
 * selects/navigates. dnd-kit's PointerSensor only starts a drag once the
 * pointer moves past `activationConstraint.distance`, so a stationary click
 * passes through untouched; interactive controls inside the row (the "…"
 * menu trigger) additionally stop propagation on `pointerdown` so they never
 * register as a drag start at all (mirrors TabsStrip's `tab__close`).
 *
 * IMPORTANT: that activation-distance check only gates whether a *drag*
 * starts — it does NOT stop the browser from firing a `click` when the
 * pointer is released, no matter how far it moved in between. Because these
 * rows are `<a href>` elements (React Router `<Link>`s), that trailing click
 * makes the browser NAVIGATE to the dragged row's URL, selecting it as a
 * side effect of a pure reorder. It cannot be fixed from the row's own
 * `onClick`: dnd-kit stops the click's propagation at `document` capture
 * before React ever sees it, while leaving the anchor's default action
 * intact. `useDragClickGuard` (wired into every `DndContext` here via
 * `markDrag`) handles it from a `window`-capture listener instead — see that
 * hook for the full mechanism. The rows are additionally `draggable={false}`
 * so the browser's own link-drag never competes with dnd-kit's pointer drag.
 */
function SortableRow({
  id,
  children,
}: {
  id: string;
  children: (opts: {
    setNodeRef: (el: HTMLElement | null) => void;
    style: CSSProperties;
    attributes: ReturnType<typeof useSortable>["attributes"];
    listeners: ReturnType<typeof useSortable>["listeners"];
  }) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 1 : undefined,
    cursor: isDragging ? "grabbing" : undefined,
  };
  return children({ setNodeRef, style, attributes, listeners });
}

/**
 * A unified item in a project's worktree list: either a real worktree or a
 * worktree draft (a session in `drafting` state whose `entryPoint` is not
 * "direct"). Both carry a `sortOrder` so they can be sorted and reordered
 * together in a single DndContext/SortableContext (the draft is dispatched to
 * `api.reorderSession`, the worktree to `api.reorderWorktree`, on drag end).
 */
type ProjectWorktreeItem =
  | { kind: "worktree"; data: Worktree; id: string; sortOrder?: number }
  | { kind: "draft"; data: Session; id: string; sortOrder?: number };

/**
 * A unified item in the sidebar's top-level (Projects) reorder scope: either a
 * project or a global draft (a session with `projectId === null` in `drafting`
 * state). Both live in the same `sortOrders["projects"]` drag order and are
 * rendered in a single DndContext/SortableContext so a global draft can be
 * dragged among and between projects.
 */
type TopLevelSidebarItem =
  | { kind: "project"; data: Project; id: string }
  | { kind: "global_draft"; data: Session; id: string };

/**
 * Merge a persisted drag order with the current live id list: known ids are
 * placed per the stored order, anything not yet in the stored order (new
 * session/worktree) is appended at the end in its natural (server) order, and
 * stale ids no longer present are dropped. Never reorders by mutating the
 * live objects — callers re-sort their `.map()` input by this id list only,
 * keeping every item keyed by its own stable id (no index-keying, no remounts).
 *
 * Used ONLY by the pinned sub-lists (`pinned-worktrees`/`pinned-direct`),
 * which stay on this local-only mechanism — the server's per-worktree/
 * per-project `sortOrder` column can't express a cross-project pinned order
 * (Part 03 Decision 1 exception). Formerly exported from `useStore.ts` as
 * `applySortOrder`; moved here since this is now its only consumer.
 */
function applyLocalSortOrder(order: string[] | undefined, liveIds: string[]): string[] {
  if (!order || order.length === 0) return liveIds;
  const liveSet = new Set(liveIds);
  const known = order.filter((id) => liveSet.has(id));
  const knownSet = new Set(known);
  const rest = liveIds.filter((id) => !knownSet.has(id));
  return [...known, ...rest];
}

/** First 3 characters for collapsed rail labels (trimmed, min 1 char). */
function abbrevLabel(name: string): string {
  const t = name.trim();
  if (t.length === 0) return "—";
  return t.slice(0, 3);
}

/** When several siblings share the same 3-letter prefix, suffix from id for a stable unique chip. */
function disambiguatedAbbrev(
  name: string,
  id: string,
  peers: readonly { id: string; name: string }[],
): string {
  const base = abbrevLabel(name);
  const dup = peers.filter((p) => abbrevLabel(p.name) === base);
  if (dup.length <= 1) return base;
  const tail =
    id.replace(/[^a-zA-Z0-9]/g, "").slice(-1) ||
    id.slice(-1) ||
    "?";
  const stem = base.replace(/[-–—.]$/u, "").slice(0, 2);
  return `${stem}${tail}`.slice(0, 3);
}

/** Map SessionState to WorktreeRolledUpStatus for StatusDot. */
function sessionStateToStatus(state: SessionState): WorktreeRolledUpStatus {
  if (state === "not_started") return "spawning";
  if (state === "drafting") return "none";
  return state; // working, idle, waiting_for_human, done, exited all map directly
}

function worktreeIsInactive(sessions: Session[], live: Record<string, SessionState | undefined>): boolean {
  const agents = sessions.filter((s) => s.type === "agent");
  if (agents.length === 0) return true;
  // "Hide done" hides only worktrees the user explicitly marked done — NOT
  // `exited`. Exited is involuntary (agent crashed, tmux pane died, or the
  // tmux server was lost on reboot), and after a restart every session lands
  // in `exited`. Folding it in here hid all previously-active worktrees behind
  // a filter labelled "done", so keep exited visible.
  return agents.every((s) => {
    const st = live[s.id] ?? s.state;
    return st === "done";
  });
}

/** `+N −N` LOC indicator (item 10, Decision 11) — reuses the VCS graph's
 *  existing add/del text-color classes. Renders nothing while the stat is
 *  unknown (still in flight / failed) or genuinely zero-diff. */
function DiffStatBadge({ stat }: { stat: { insertions: number; deletions: number } | null }) {
  if (!stat || (stat.insertions === 0 && stat.deletions === 0)) return null;
  return (
    <span className="wt-row__diffstat">
      {stat.insertions > 0 ? <span className="vcs-graph__add">+{stat.insertions}</span> : null}
      {stat.deletions > 0 ? <span className="vcs-graph__del">−{stat.deletions}</span> : null}
    </span>
  );
}

function SidebarSessionModeIcon({
  session,
  api,
}: {
  session: Session;
  api?: ApiInstance;
}) {
  const iconKey = useModeIcon(sessionModeId(session), api, session.modeIcon);
  return (
    <span className="direct-session__mode-icon" aria-hidden="true">
      <ModeIcon iconKey={iconKey} channel={session.channel} size={13} />
    </span>
  );
}

interface LeftSidebarProps {
  api: ApiInstance;
  /** Narrow desktop rail: abbreviated labels + compact controls */
  collapsed?: boolean;
  /** Mobile drawer: show pinned brand link at top */
  isMobile?: boolean;
  onWorktreeSelected?: (wtId: string) => void;
  /** Opens the keyboard-shortcuts reference dialog (owned by Workspace/TopBar) — the
   *  footer's Keyboard button triggers it since TopBar no longer has its own trigger. */
  onOpenShortcuts?: () => void;
  /** Optional top header slot (absorbs top-bar-left in classic per-worktree layout) */
  header?: ReactNode;
}

export function LeftSidebar({
  api,
  collapsed = false,
  isMobile = false,
  onWorktreeSelected,
  onOpenShortcuts,
  header,
}: LeftSidebarProps) {
  const envWidth = useViewportWidth();
  const demoEnv = useDemoEnv();
  const envHeight = demoEnv.viewport?.h ?? (typeof window !== "undefined" ? window.innerHeight : 800);
  const portalRoot = usePortalRoot();
  const { doc } = useEventTargets();
  const location = useLocation();
  const navigate = useNavigate();
  const { toggleFont } = useTheme();
  const doctorStatus = useDoctorStatus(api);
  // Server data comes from the central store, populated and refreshed by
  // `useServerSync` (mounted once in Workspace). LeftSidebar derives the
  // by-project / by-worktree maps it needs from those flat arrays — keeping
  // a single source of truth instead of mirroring it into local state.
  const projects = useServerStore((s) => s.projects);
  const worktrees = useServerStore((s) => s.worktrees);
  const sessions = useServerStore((s) => s.sessions);
  /** Non-hidden worktrees, grouped by project — the only ones rendered in the
   *  normal per-project list. Hidden worktrees surface only via `hiddenWorktreeMap`
   *  below (the project's "Hidden worktrees" dialog). */
  const worktreeMap = useMemo(() => {
    const m: Record<string, Worktree[]> = {};
    for (const w of worktrees) {
      if (w.hiddenAt != null) continue;
      (m[w.projectId] ??= []).push(w);
    }
    return m;
  }, [worktrees]);
  /** Non-hidden worktree ids — batched into one `useWorktreeDiffStats` poll
   *  (Decision 11) instead of each row owning its own interval. */
  const visibleWorktreeIds = useMemo(
    () => worktrees.filter((w) => w.hiddenAt == null).map((w) => w.id),
    [worktrees],
  );
  const diffStats = useWorktreeDiffStats(api, visibleWorktreeIds);
  /** Hidden worktrees, grouped by project — feeds the "Hidden worktrees" dialog
   *  and the count shown in the project overflow menu. */
  const hiddenWorktreeMap = useMemo(() => {
    const m: Record<string, Worktree[]> = {};
    for (const w of worktrees) {
      if (w.hiddenAt == null) continue;
      (m[w.projectId] ??= []).push(w);
    }
    return m;
  }, [worktrees]);
  const sessionMap = useMemo(() => {
    const m: Record<string, Session[]> = {};
    for (const s of sessions) {
      // Skip direct sessions (worktreeId === null) — they go in directSessionMap
      if (s.worktreeId != null) {
        (m[s.worktreeId] ??= []).push(s);
      }
    }
    return m;
  }, [sessions]);
  /**
   * Direct *agent* sessions grouped by projectId.
   *
   * Agents only — the sidebar lists agents, never terminals. The terminal dock
   * auto-creates a shell for the project scope (TabsStrip), which lands in
   * project.directSessions; without this filter it surfaces as a bogus
   * top-level "Terminal 1" row. The worktree path already filters terminals
   * out (see worktreeIsInactive / worktreeRolledUpStatus).
   */
  const directSessionMap = useMemo(() => {
    const m: Record<string, Session[]> = {};
    for (const s of sessions) {
      // Skip drafts (state === "drafting") — they render as their own Tier 1
      // draft rows appended after this list, not as regular direct rows.
      if (s.worktreeId === null && s.projectId && s.type === "agent" && s.state !== "drafting") {
        (m[s.projectId] ??= []).push(s);
      }
    }
    // Pinned sessions first (newest pin on top), then the rest by id for stability.
    for (const id of Object.keys(m)) {
      m[id]!.sort((a, b) => {
        const ap = a.pinnedAt ?? "";
        const bp = b.pinnedAt ?? "";
        if (!!ap !== !!bp) return ap ? -1 : 1;
        if (ap && bp && ap !== bp) return ap < bp ? 1 : -1; // newer pin first
        return a.id < b.id ? -1 : 1;
      });
    }
    return m;
  }, [sessions]);
  /** Project lookup for the project-name subheader on pinned rows. */
  const projectById = useMemo(() => {
    const m: Record<string, Project> = {};
    for (const p of projects) m[p.id] = p;
    return m;
  }, [projects]);
  /** Ids of hidden projects — their rows + all their worktrees are filtered out
   *  of the sidebar everywhere (projects list AND pinned section). */
  const hiddenProjectIds = useMemo(
    () => new Set(projects.filter((p) => p.hidden).map((p) => p.id)),
    [projects],
  );
  /** Visible (non-hidden) projects — the only ones rendered in the tree. */
  const visibleProjects = useMemo(
    () => projects.filter((p) => !p.hidden),
    [projects],
  );
  /**
   * Pinned worktrees in display order: ISO timestamp DESC (newest pinned first).
   * Filter out anything no longer present on the server (defense-in-depth — the
   * server-side delete naturally removes pinned worktrees, but a stale id from
   * an in-flight event shouldn't crash render) and any worktree of a hidden project.
   */
  const pinnedWorktrees = useMemo(
    () =>
      worktrees
        .filter((w) => w.pinnedAt != null && w.hiddenAt == null && !hiddenProjectIds.has(w.projectId))
        .slice()
        .sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "")),
    [worktrees, hiddenProjectIds],
  );
  /**
   * Pinned direct sessions (no worktree), newest pin first. Shown in the same
   * "Pinned" section as worktrees so "Pin to top" surfaces them at the top of
   * the sidebar, not just within their project group.
   */
  const pinnedDirectSessions = useMemo(
    () =>
      sessions
        // Agents only — same reasoning as directSessionMap above.
        .filter(
          (s) =>
            s.worktreeId === null &&
            s.type === "agent" &&
            s.pinnedAt != null &&
            s.projectId != null &&
            !hiddenProjectIds.has(s.projectId),
        )
        .slice()
        .sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "")),
    [sessions, hiddenProjectIds],
  );
  const hasPinned = pinnedWorktrees.length > 0 || pinnedDirectSessions.length > 0;

  // --- Rename + drag-reorder (Part 03 Phase 2): real daemon endpoints for
  // regular (unpinned) worktree/direct-session scopes, via the per-worktree/
  // per-project `sortOrder` column, which can't express a cross-project
  // pinned order (Decision 1 exception). The `pinned-all` sub-list is ALSO
  // daemon-synced now (pinned-order-sync), but through a separate mechanism:
  // a generic `user_ordered_lists` table keyed by scopeKey, not the
  // `sortOrder` column — see `handleReorder`'s `scopeKey === "pinned-all"`
  // branch below. Every other scope (`projects`, `workspaces:global`) still
  // uses the old local-only `sortOrders` mechanism (`applyLocalSortOrder`
  // above). ---
  const sortOrders = useWorkspaceStore((s) => s.sortOrders);
  const setSortOrder = useWorkspaceStore((s) => s.setSortOrder);
  // --- Saved workspace layouts (per-worktree, purely client-side — no daemon
  // route exists for any of this). Reorder mirrors the pinned sub-lists'
  // local-only `sortOrders` mechanism above (`workspaceOrder` + `reorderWorkspace`),
  // since WorkspaceDoc order can't be expressed by the server's sortOrder column
  // at all (there's no server entity). ---
  const workspaceDocs = useWorkspaceStore((s) => s.workspaceDocs);
  const workspaceOrder = useWorkspaceStore((s) => s.workspaceOrder);
  const reorderWorkspace = useWorkspaceStore((s) => s.reorderWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setLayoutMode = useWorkspaceStore((s) => s.setLayoutMode);
  const layoutByWorktree = useWorkspaceStore((s) => s.layoutByWorktree);
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  /**
   * Suppresses the browser's trailing `click` after a drag-to-reorder, which
   * would otherwise navigate these `<a href>` rows to the dragged worktree/
   * session — i.e. select it as a side effect of a pure reorder. `markDrag`
   * is wired into EVERY `DndContext` below (onDragStart/onDragEnd/
   * onDragCancel). See `useDragClickGuard` for why a React `onClick` handler
   * cannot fix this on its own.
   */
  const markDrag = useDragClickGuard();


  // --- Inline double-click rename (Part 03 Phase 3) — mirrors TabsStrip.tsx's
  // startRename/commitRename/renamingId/renameValue/renameInputRef pattern
  // exactly, replacing the old modal RenameDialog entirely (Decision 8, 9). ---
  // `site` distinguishes the "Pinned" section copy of a row from its regular
  // project-tree copy: pinned worktrees/direct-sessions are MIRRORED, not
  // moved, so the same `id` can render simultaneously in both places. Keying
  // solely by `{kind, id}` made double-clicking either copy flip BOTH into
  // edit mode at once — two autoFocus inputs fighting for focus, where the
  // loser's onBlur fires immediately and commits a rename with the unedited
  // value. Including `site` ensures only the row actually double-clicked
  // ever renders an input.
  const [inlineRename, setInlineRename] = useState<
    { kind: "worktree" | "session" | "workspace"; id: string; site: "pinned" | "tree" } | null
  >(null);
  const [inlineValue, setInlineValue] = useState("");
  const inlineInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inlineRename) inlineInputRef.current?.focus();
  }, [inlineRename]);

  function startInlineRename(
    kind: "worktree" | "session" | "workspace",
    id: string,
    currentLabel: string,
    site: "pinned" | "tree",
  ) {
    setInlineRename({ kind, id, site });
    setInlineValue(currentLabel);
  }

  /**
   * A double-click dispatches `click` (detail 1), `click` (detail 2), THEN
   * `dblclick` — the row's full-bleed `<Link>` overlay already acts on the
   * first `click` before `dblclick` ever fires, so `preventDefault()` in an
   * `onDoubleClick` handler is always too late to stop the navigation that
   * already happened. Browsers set `event.detail` to the click count, so an
   * `onClickCapture` on the row (capture phase runs BEFORE the `<Link>`'s own
   * `onClick`, which lives at the target) can intercept the second click of
   * a double-click and stop it from reaching the anchor at all.
   */
  function suppressDoubleClickNavigation(e: React.MouseEvent) {
    if (e.detail > 1) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function commitInlineRename() {
    const target = inlineRename;
    setInlineRename(null);
    if (!target) return;
    // Unconditional: an empty submission is a valid request to clear the
    // name back to the server's computed default (name -> null), not a
    // silent no-op — matches the rename endpoint's contract.
    const trimmed = inlineValue.trim().slice(0, 60);
    if (target.kind === "worktree") {
      void api.renameWorktree(target.id, trimmed).catch(() => {
        /* surface errors later */
      });
    } else if (target.kind === "session") {
      void api.renameSession(target.id, trimmed).catch(() => {
        /* surface errors later */
      });
    } else {
      // Workspace: purely client-side entity, no daemon route — commit
      // straight to the store. Unlike worktree/session rename, there's no
      // server-computed default to fall back to on empty input, so an empty
      // submission is treated as a no-op (keeps the previous name) rather
      // than clearing it.
      if (trimmed) renameWorkspace(target.id, trimmed);
    }
  }

  /** Reorder scope: pinned worktrees and direct sessions float in a single drag-order list,
   *  independent of pin recency once the user has dragged them (documented
   *  choice — see task write-up: pin recency is only the *default* order).
   *  `sortOrders["pinned-all"]` is now daemon-synced (pinned-order-sync) —
   *  hydrated on mount/reconnect and kept live via `orderedList:updated`
   *  (see `useServerSync.ts`), so this read site needs no changes. */
  const orderedPinnedItems = useMemo(() => {
    const items = [
      ...pinnedWorktrees.map((w) => ({ id: w.id, kind: "worktree" as const, data: w })),
      ...pinnedDirectSessions.map((s) => ({ id: s.id, kind: "session" as const, data: s })),
    ];
    // Sort by pinnedAt DESC
    items.sort((a, b) => {
      const aTime = a.data.pinnedAt ?? "";
      const bTime = b.data.pinnedAt ?? "";
      return bTime.localeCompare(aTime);
    });
    const ids = items.map((x) => x.id);
    const order = applyLocalSortOrder(sortOrders["pinned-all"], ids);
    const byId = new Map(items.map((x) => [x.id, x]));
    return order.map((id) => byId.get(id)!).filter(Boolean);
  }, [pinnedWorktrees, pinnedDirectSessions, sortOrders]);

  /** Projects reorder scope — local-only (Decision 1 exception, same as
   *  pinned lists): no `Project.sortOrder` field/route exists server-side.
   *  Now a unified top-level scope that mixes projects and global drafts
   *  (`TopLevelSidebarItem`), ordered by `sortOrders["projects"]`. New global
   *  drafts not yet persisted in that order float to the top (ordered by their
   *  server `sortOrder`) so a freshly created draft is immediately visible. */
  const orderedTopLevelItems = useMemo<TopLevelSidebarItem[]>(() => {
    const globalDrafts = sessions
      .filter((s) => s.projectId === null && s.state === "drafting")
      .slice()
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const items: TopLevelSidebarItem[] = [
      ...visibleProjects.map((p) => ({ kind: "project" as const, data: p, id: p.id })),
      ...globalDrafts.map((s) => ({ kind: "global_draft" as const, data: s, id: s.id })),
    ];
    const stored = sortOrders["projects"] ?? [];
    const storedSet = new Set(stored);
    const knownIds = stored.filter((id) => items.some((x) => x.id === id));
    const knownSet = new Set(knownIds);
    const knownItems = knownIds
      .map((id) => items.find((x) => x.id === id)!)
      .filter(Boolean);
    const newDrafts = items.filter(
      (x) => x.kind === "global_draft" && !knownSet.has(x.id),
    );
    const rest = items.filter((x) => !knownSet.has(x.id) && x.kind !== "global_draft");
    return [...newDrafts, ...knownItems, ...rest];
  }, [visibleProjects, sessions, sortOrders]);

  /** Pinned-scope reorder handler. `pinned-all` is now daemon-synced
   *  (pinned-order-sync) — every other scope stays on the old local-only
   *  `sortOrders` mechanism (see the comment above `sortOrders`). */
  function handleReorder(scopeKey: string, currentIds: string[], e: DragEndEvent) {
    // Mark BEFORE the early return: a drag that ends where it started still
    // produces the trailing click that would navigate the row's <a href>.
    markDrag();
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = currentIds.indexOf(String(active.id));
    const to = currentIds.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    const next = currentIds.slice();
    next.splice(from, 1);
    next.splice(to, 0, String(active.id));
    setSortOrder(scopeKey, next);

    if (scopeKey === "pinned-all") {
      const p = api.setOrderedList("pinned-all", next).catch(() => {
        // Stale until the next successful write or reload — there is
        // nothing to roll back to, local state already reflects intent.
      });
      markOrderedListWrite(p);
      // Compare-and-clear: if a second drag started a newer write before
      // this one settles, clearOrderedListWrite no-ops instead of wiping
      // the newer promise out from under it.
      void p.finally(() => clearOrderedListWrite(p));
    }
  }

  /** Top-level (Projects) reorder — a unified scope mixing projects and global
   *  drafts. Persists the full order to `sortOrders["projects"]` locally. If the
   *  moved item is a global draft, also syncs its server `sortOrder` via
   *  `api.reorderSession` (fractional interpolation against its draft
   *  neighbours in the new order). */
  function handleTopLevelReorder(e: DragEndEvent) {
    markDrag();
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = orderedTopLevelItems.map((x) => x.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    const next = ids.slice();
    next.splice(from, 1);
    next.splice(to, 0, String(active.id));
    setSortOrder("projects", next);

    const moved = orderedTopLevelItems[from];
    if (moved?.kind !== "global_draft") return;
    const prevSortOrder = moved.data.sortOrder;

    const draftOrder = next
      .map((id) => orderedTopLevelItems.find((x) => x.id === id)!)
      .filter((x) => x.kind === "global_draft") as Extract<
      TopLevelSidebarItem,
      { kind: "global_draft" }
    >[];
    const movedIndex = draftOrder.indexOf(moved);
    const prevDraft = draftOrder[movedIndex - 1];
    const nextDraft = draftOrder[movedIndex + 1];
    const newSortOrder = computeNewSortOrder(
      prevDraft?.data.sortOrder,
      nextDraft?.data.sortOrder,
    );

    const patch = (sortOrder: number | undefined) => {
      useServerStore.getState().applySessionUpdated(moved.id, { sortOrder });
    };
    patch(newSortOrder);
    void api.reorderSession(moved.id, newSortOrder).catch(() => {
      patch(prevSortOrder);
    });
  }

  /** Workspaces-section reorder — client-only, mirrors `handleReorder` above
   *  but writes to `workspaceOrder`/`reorderWorkspace` (no daemon route). */
  function handleWorkspaceReorder(scopeKey: string, currentIds: string[], e: DragEndEvent) {
    markDrag();
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = currentIds.indexOf(String(active.id));
    const to = currentIds.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    const next = currentIds.slice();
    next.splice(from, 1);
    next.splice(to, 0, String(active.id));
    reorderWorkspace(scopeKey, next);
  }

  /** Non-pinned worktree/direct-session reorder — real server `sortOrder`
   *  (Part 03 Decision 1). `orderedList` is the current (real-sortOrder)
   *  order; `kind` selects which reorder endpoint to call. */
  function handleServerReorder(
    orderedList: (Worktree | Session)[],
    kindArg: "worktree" | "session",
    e: DragEndEvent,
  ) {
    // Mark BEFORE the early return — see handleReorder.
    markDrag();
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = orderedList.findIndex((x) => x.id === String(active.id));
    const to = orderedList.findIndex((x) => x.id === String(over.id));
    if (from === -1 || to === -1) return;
    const moved = orderedList[from]!;
    const prevSortOrder = moved.sortOrder;

    const reordered = orderedList.slice();
    reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    const newIndex = reordered.indexOf(moved);
    const prevNeighbor = reordered[newIndex - 1];
    const nextNeighbor = reordered[newIndex + 1];
    const newSortOrder = computeNewSortOrder(prevNeighbor?.sortOrder, nextNeighbor?.sortOrder);

    const patch = (sortOrder: number | undefined) => {
      if (kindArg === "worktree") {
        useServerStore.getState().applyWorktreeUpdated({ ...(moved as Worktree), sortOrder });
      } else {
        useServerStore.getState().applySessionUpdated(moved.id, { sortOrder });
      }
    };

    patch(newSortOrder);
    const call =
      kindArg === "worktree"
        ? api.reorderWorktree(moved.id, newSortOrder)
        : api.reorderSession(moved.id, newSortOrder);
    void call.catch(() => {
      patch(prevSortOrder);
    });
  }

  /** Reorder over a unified project list that mixes worktrees and worktree
   *  drafts (`ProjectWorktreeItem`). Fractional sortOrder interpolation is
   *  shared; the dispatch to `reorderWorktree` vs `reorderSession` is chosen
   *  by the moved item's kind. */
  function handleServerReorderMixed(orderedList: ProjectWorktreeItem[], e: DragEndEvent) {
    // Mark BEFORE the early return — see handleServerReorder.
    markDrag();
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = orderedList.findIndex((x) => x.id === String(active.id));
    const to = orderedList.findIndex((x) => x.id === String(over.id));
    if (from === -1 || to === -1) return;
    const moved = orderedList[from]!;
    const prevSortOrder = moved.sortOrder;

    const reordered = orderedList.slice();
    reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    const newIndex = reordered.indexOf(moved);
    const prevNeighbor = reordered[newIndex - 1];
    const nextNeighbor = reordered[newIndex + 1];
    const newSortOrder = computeNewSortOrder(prevNeighbor?.sortOrder, nextNeighbor?.sortOrder);

    const patch = (sortOrder: number | undefined) => {
      if (moved.kind === "worktree") {
        useServerStore.getState().applyWorktreeUpdated({ ...(moved.data as Worktree), sortOrder });
      } else {
        useServerStore.getState().applySessionUpdated(moved.id, { sortOrder });
      }
    };

    patch(newSortOrder);
    const call =
      moved.kind === "worktree"
        ? api.reorderWorktree(moved.id, newSortOrder)
        : api.reorderSession(moved.id, newSortOrder);
    void call.catch(() => {
      patch(prevSortOrder);
    });
  }
  const [openProj, setOpenProj] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("sidebar:openProj");
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch { /* ignore */ }
    return new Set<string>();
  });

  const { activeWorktreeId, activeProjectId, activeSessionId, setActiveWorktree, setActiveSession } = useLayout();
  const clearWorkspaceSelection = useWorkspaceStore((s) => s.clearWorkspaceSelection);
  const setMobileSidebarOpen = useWorkspaceStore((s) => s.setMobileSidebarOpen);
  const mobileSidebarOpen = useWorkspaceStore((s) => s.mobileSidebarOpen);
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);
  const hideInactiveWorktrees = useWorkspaceStore((s) => s.hideInactiveWorktrees);
  const toggleInactiveWorktreesFilter = useWorkspaceStore((s) => s.toggleInactiveWorktreesFilter);

  /** "Workspaces" section collapse state — mirrors `openProj`'s
   *  localStorage-persisted chevron-disclosure pattern above, just a single
   *  boolean instead of a per-project Set since there's only one section. */
  const [workspacesOpen, setWorkspacesOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("sidebar:workspacesOpen");
      if (saved != null) return saved === "1";
    } catch { /* ignore */ }
    return true;
  });

  /** "Pinned" section collapse state — same persisted-boolean shape as `workspacesOpen`. */
  const [pinnedOpen, setPinnedOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("sidebar:pinnedOpen");
      if (saved != null) return saved === "1";
    } catch { /* ignore */ }
    return true;
  });

  /** Direct agents section disclosure state per project — collapsed by default. */
  const [openDirectAgents, setOpenDirectAgents] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("sidebar:openDirectAgents");
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch { /* ignore */ }
    return new Set<string>();
  });

  function toggleDirectAgents(projectId: string) {
    setOpenDirectAgents((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  /** Worktree expansion state (for showing agents under worktree) */
  const [openWorktrees, setOpenWorktrees] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("sidebar:openWorktrees");
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch { /* ignore */ }
    return new Set<string>();
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const preSearchSnapshotRef = useRef<{
    openProj: Set<string>;
    openWorktrees: Set<string>;
    openDirectAgents: Set<string>;
    workspacesOpen: boolean;
    pinnedOpen: boolean;
  } | null>(null);

  function handleSearchChange(nextVal: string) {
    // Compare TRIMMED values for the expand/restore transition — a
    // whitespace-only query is not a real query (`trimmedQuery` below treats
    // it as empty too), so typing only spaces must not force-expand
    // everything with nothing actually filtered (found in review).
    const prev = searchQuery.trim();
    const next = nextVal.trim();
    if (!prev && next) {
      preSearchSnapshotRef.current = {
        openProj: new Set(openProj),
        openWorktrees: new Set(openWorktrees),
        openDirectAgents: new Set(openDirectAgents),
        workspacesOpen,
        pinnedOpen,
      };
      setOpenProj(new Set(projects.map((p) => p.id)));
      setOpenWorktrees(new Set(worktrees.map((w) => w.id)));
      setOpenDirectAgents(new Set(projects.map((p) => p.id)));
      setWorkspacesOpen(true);
      setPinnedOpen(true);
    } else if (prev && !next) {
      if (preSearchSnapshotRef.current) {
        setOpenProj(preSearchSnapshotRef.current.openProj);
        setOpenWorktrees(preSearchSnapshotRef.current.openWorktrees);
        setOpenDirectAgents(preSearchSnapshotRef.current.openDirectAgents);
        setWorkspacesOpen(preSearchSnapshotRef.current.workspacesOpen);
        setPinnedOpen(preSearchSnapshotRef.current.pinnedOpen);
        preSearchSnapshotRef.current = null;
      }
    }
    setSearchQuery(nextVal);
  }

  useEffect(() => {
    if (preSearchSnapshotRef.current != null) return;
    try {
      localStorage.setItem("sidebar:workspacesOpen", workspacesOpen ? "1" : "0");
    } catch { /* ignore */ }
  }, [workspacesOpen]);

  useEffect(() => {
    if (preSearchSnapshotRef.current != null) return;
    try {
      localStorage.setItem("sidebar:pinnedOpen", pinnedOpen ? "1" : "0");
    } catch { /* ignore */ }
  }, [pinnedOpen]);

  /** ALL saved workspaces, globally — detached from any owning worktree
   *  (agent-interaction-workspaces/04-workspaces Phase 3b, Decision 6). A
   *  saved workspace is independent once created, so it's listed regardless
   *  of which worktree (or none — the dashboard) is currently active.
   *  `contextKey` (the worktree it was originally created in) is provenance
   *  only now, not a filter (Decision 5). */
  const allWorkspaces = useMemo(() => Object.values(workspaceDocs), [workspaceDocs]);
  /** Single global ordering key — the section is no longer per-worktree, so
   *  its reorder state isn't either. */
  const workspacesScopeKey = "workspaces:global";
  const orderedWorkspaces = useMemo(() => {
    const ids = allWorkspaces.map((d) => d.id);
    const order = applyLocalSortOrder(workspaceOrder[workspacesScopeKey], ids);
    const byId = new Map(allWorkspaces.map((d) => [d.id, d]));
    return order.map((id) => byId.get(id)!).filter(Boolean);
  }, [allWorkspaces, workspaceOrder, workspacesScopeKey]);
  /** "Currently viewing this workspace" is route-driven now (Decision 4), not
   *  a per-worktree pointer — highlight the row whose id matches the open
   *  `/workspaces/:id` route. */
  const activeDetachedWorkspaceId = location.pathname.startsWith("/workspaces/")
    ? location.pathname.slice("/workspaces/".length)
    : null;

  const [plusMenu, setPlusMenu] = useState<{ project: Project; rect: DOMRect } | null>(null);
  const [wtMenu, setWtMenu] = useState<{ projectId: string; worktree: Worktree; rect: DOMRect } | null>(null);
  const [sessMenu, setSessMenu] = useState<{ session: Session; rect: DOMRect } | null>(null);
  const [projMenu, setProjMenu] = useState<{ project: Project; rect: DOMRect } | null>(null);

  /** Scroll container — used to snap the active worktree into view when the
   *  sidebar is reopened (see effect below). */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Whether the sidebar was visible on the previous render, to detect the
   *  hidden→visible (reopen) rising edge. Seeded to the current visibility so a
   *  mount with an already-open sidebar still snaps once. */
  const visible = isMobile ? mobileSidebarOpen : !collapsed;
  const prevVisibleRef = useRef<boolean>(!visible);
  const [filterMenuRect, setFilterMenuRect] = useState<DOMRect | null>(null);
  /** Id of the project whose "Hidden worktrees" dialog is open, or null when closed. */
  const [hiddenWtDialogProjectId, setHiddenWtDialogProjectId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Worktree | null>(null);
  const [pendingHideProject, setPendingHideProject] = useState<{ project: Project; rect: DOMRect } | null>(null);
  const [pendingTerminateSession, setPendingTerminateSession] = useState<Session | null>(null);
  const [pendingDeleteWorkspace, setPendingDeleteWorkspace] = useState<WorkspaceDoc | null>(null);
  const [pendingDiscardDraft, setPendingDiscardDraft] = useState<
    { kind: "global" } | { kind: "session"; session: Session } | null
  >(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  // Subscribe to live session output for every session we know about so the
  // rollup picks up state transitions in real time. The set of ids comes from
  // the central store, recomputed cheaply via useMemo+sort+join.
  const sessionIdKey = useMemo(
    () => sessions.map((s) => s.id).sort().join(","),
    [sessions],
  );
  useSubscription(sessionIdKey ? sessionIdKey.split(",").filter(Boolean) : [], api);

  /** Close-on-outside must attach after the opening click finishes (same tap was closing the menu / breaking UI). */
  useEffect(() => {
    if (!wtMenu) return undefined;
    let removeListeners: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      function onDocClick(ev: MouseEvent) {
        const t = ev.target as HTMLElement;
        if (t.closest("[data-wt-menu-panel]") || t.closest("[data-wt-menu-trigger]")) return;
        setWtMenu(null);
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") setWtMenu(null);
      }
      doc.addEventListener("click", onDocClick);
      doc.addEventListener("keydown", onKey);
      removeListeners = () => {
        doc.removeEventListener("click", onDocClick);
        doc.removeEventListener("keydown", onKey);
      };
    }, 0);
    return () => {
      window.clearTimeout(timer);
      removeListeners?.();
    };
  }, [wtMenu]);

  useEffect(() => {
    if (!sessMenu) return undefined;
    let removeListeners: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      function onDocClick(ev: MouseEvent) {
        const t = ev.target as HTMLElement;
        if (t.closest("[data-sess-menu-panel]") || t.closest("[data-sess-menu-trigger]")) return;
        setSessMenu(null);
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") setSessMenu(null);
      }
      doc.addEventListener("click", onDocClick);
      doc.addEventListener("keydown", onKey);
      removeListeners = () => {
        doc.removeEventListener("click", onDocClick);
        doc.removeEventListener("keydown", onKey);
      };
    }, 0);
    return () => {
      window.clearTimeout(timer);
      removeListeners?.();
    };
  }, [sessMenu]);

  useEffect(() => {
    if (!projMenu) return undefined;
    let removeListeners: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      function onDocClick(ev: MouseEvent) {
        const t = ev.target as HTMLElement;
        if (t.closest("[data-proj-menu-panel]") || t.closest("[data-proj-menu-trigger]")) return;
        setProjMenu(null);
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") setProjMenu(null);
      }
      doc.addEventListener("click", onDocClick);
      doc.addEventListener("keydown", onKey);
      removeListeners = () => {
        doc.removeEventListener("click", onDocClick);
        doc.removeEventListener("keydown", onKey);
      };
    }, 0);
    return () => {
      window.clearTimeout(timer);
      removeListeners?.();
    };
  }, [projMenu]);

  useEffect(() => {
    if (!pendingHideProject) return undefined;
    let removeListeners: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      function onDocClick(ev: MouseEvent) {
        const t = ev.target as HTMLElement;
        if (t.closest("[data-hide-project-popup]") || t.closest("[data-proj-menu-trigger]")) return;
        setPendingHideProject(null);
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") setPendingHideProject(null);
      }
      doc.addEventListener("click", onDocClick);
      doc.addEventListener("keydown", onKey);
      removeListeners = () => {
        doc.removeEventListener("click", onDocClick);
        doc.removeEventListener("keydown", onKey);
      };
    }, 0);
    return () => {
      window.clearTimeout(timer);
      removeListeners?.();
    };
  }, [pendingHideProject]);

  // Close plus menu on outside click
  useEffect(() => {
    if (!plusMenu) return undefined;
    let removeListeners: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      function onDocClick(ev: MouseEvent) {
        const t = ev.target as HTMLElement;
        if (t.closest("[data-project-plus-menu]") || t.closest("[data-plus-menu-trigger]")) return;
        setPlusMenu(null);
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") setPlusMenu(null);
      }
      doc.addEventListener("click", onDocClick);
      doc.addEventListener("keydown", onKey);
      removeListeners = () => {
        doc.removeEventListener("click", onDocClick);
        doc.removeEventListener("keydown", onKey);
      };
    }, 0);
    return () => {
      window.clearTimeout(timer);
      removeListeners?.();
    };
  }, [plusMenu]);

  useEffect(() => {
    if (!filterMenuRect) return undefined;
    let removeListeners: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      function onDocClick(ev: MouseEvent) {
        const t = ev.target as HTMLElement;
        if (t.closest("[data-filter-menu-panel]") || t.closest("[data-filter-menu-trigger]")) return;
        setFilterMenuRect(null);
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") setFilterMenuRect(null);
      }
      doc.addEventListener("click", onDocClick);
      doc.addEventListener("keydown", onKey);
      removeListeners = () => {
        doc.removeEventListener("click", onDocClick);
        doc.removeEventListener("keydown", onKey);
      };
    }, 0);
    return () => {
      window.clearTimeout(timer);
      removeListeners?.();
    };
  }, [filterMenuRect]);

  async function confirmDeleteWorktree() {
    if (!pendingDelete) return;
    const worktree = pendingDelete;
    setPendingDelete(null);
    try {
      // No `enforceDone` here: this is an explicit, confirmed single-worktree
      // delete, and the confirm copy already promises attached sessions go
      // with it — the daemon releases/kills them as part of the delete. Only
      // Settings → Storage opts into the `worktree_not_done` guard.
      await api.deleteWorktree(worktree.id);
      if (activeWorktreeId === worktree.id) {
        clearWorkspaceSelection();
      }
      // Store stays current via the `worktree:deleted` WS event handled in
      // useServerSync — no manual refresh needed.
    } catch (err) {
      // Previously a bare `catch { /* surface errors later */ }`, which made a
      // failed removal look like nothing happened at all. Same mechanism as
      // `confirmTerminateSession` below — web-ui still has no toast/banner
      // infra, so this uses the browser-native alert rather than inventing it.
      window.alert(err instanceof Error ? err.message : "Failed to remove worktree.");
    }
  }

  async function confirmHideProject() {
    if (!pendingHideProject) return;
    const project = pendingHideProject.project;
    setPendingHideProject(null);
    try {
      await api.hideProject(project.id);
      // Store stays current via the `project:updated` WS event;
      // the active-project redirect is handled in Workspace.
    } catch {
      /* surface errors later */
    }
  }

  async function confirmTerminateSession() {
    if (!pendingTerminateSession) return;
    const sess = pendingTerminateSession;
    setPendingTerminateSession(null);
    // If we're viewing the session being terminated, leave for the next direct
    // agent (neighbor in tab order, else the Project tab) BEFORE deletion so
    // we don't briefly render a dead session. The store-side open-tab prune
    // and neighbor re-selection arrive via the `session:deleted` WS handler;
    // this just drives the URL to the same neighbor the handler will pick.
    if (location.pathname === `/project/${sess.projectId}/${sess.id}` && sess.projectId) {
      const pid = sess.projectId;
      const openTabs = useWorkspaceStore.getState().openDirectAgentTabsByProject[pid] ?? [];
      const next = pickNextDirectAgent(openTabs, sess, sessions);
      navigate(next ? `/project/${pid}/${next}` : `/project/${pid}`, { replace: true });
    }
    try {
      // Removes the session record + kills the process + removes its data dir.
      // The daemon NEVER deletes the project's own files (guarded server-side).
      await api.terminateSession(sess.id);
    } catch (err) {
      // The only remaining failure for this call is "main session, no
      // eligible sibling to promote" (Fix 1) — the one case a user must be
      // told about, since it's no longer the default outcome for every
      // main-session terminate. No toast/error-banner mechanism exists
      // anywhere in web-ui (grepped this file, WorkspaceCanvas.tsx,
      // DashboardPanel.tsx — all use the same bare "surface errors later"
      // catch), so this uses the browser-native alert() rather than
      // inventing new UI infra, per the plan's explicit instruction.
      window.alert(err instanceof Error ? err.message : "Failed to terminate session.");
    }
  }

  /** Client-side-only delete (no daemon call) — mirrors the confirm-dialog
   *  pattern used for worktree/session deletion above, but synchronous. If
   *  the deleted workspace was the active one for its worktree, fall the
   *  worktree back to classic layout so the UI doesn't point at a workspace
   *  that no longer exists. */
  function confirmDeleteWorkspace() {
    if (!pendingDeleteWorkspace) return;
    const ws = pendingDeleteWorkspace;
    setPendingDeleteWorkspace(null);
    deleteWorkspace(ws.id);
    if (layoutByWorktree[ws.contextKey]?.activeWorkspaceId === ws.id) {
      setActiveWorkspace(ws.contextKey, null);
      setLayoutMode(ws.contextKey, "classic");
    }
  }

  useEffect(() => {
    if (preSearchSnapshotRef.current != null) return;
    try {
      localStorage.setItem("sidebar:openProj", JSON.stringify([...openProj]));
    } catch { /* ignore */ }
  }, [openProj]);

  useEffect(() => {
    if (preSearchSnapshotRef.current != null) return;
    try {
      localStorage.setItem("sidebar:openDirectAgents", JSON.stringify([...openDirectAgents]));
    } catch { /* ignore */ }
  }, [openDirectAgents]);

  useEffect(() => {
    if (preSearchSnapshotRef.current != null) return;
    try {
      localStorage.setItem("sidebar:openWorktrees", JSON.stringify([...openWorktrees]));
    } catch { /* ignore */ }
  }, [openWorktrees]);


  useEffect(() => {
    const match = location.pathname.match(/^\/project\/([^/]+)\/([^/]+)$/);
    if (match) {
      const pid = match[1];
      if (pid) {
        setOpenDirectAgents((prev) => {
          if (prev.has(pid)) return prev;
          const next = new Set(prev);
          next.add(pid);
          return next;
        });
      }
    }
  }, [location.pathname]);

  useEffect(() => {
    if (!activeProjectId) return;
    if (preSearchSnapshotRef.current) {
      preSearchSnapshotRef.current.openProj.add(activeProjectId);
    }
    setOpenProj((prev) => {
      if (prev.has(activeProjectId)) return prev;
      const next = new Set(prev);
      next.add(activeProjectId);
      return next;
    });
  }, [activeProjectId]);

  // When the sidebar is reopened (desktop collapse→expand, mobile drawer open),
  // snap the selected worktree into view if it scrolled out of sight. Only on
  // the hidden→visible rising edge so we never fight the user mid-scroll.
  // `block: "nearest"` self-no-ops when the row is already visible.
  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!visible || wasVisible) return undefined;

    let raf1 = 0;
    let raf2 = 0;
    let raf3 = 0;
    function snap(): boolean {
      const el = scrollRef.current?.querySelector<HTMLElement>('[data-active="true"]');
      if (!el) return false;
      // Guard: jsdom (test env) and very old browsers lack scrollIntoView.
      if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "nearest" });
      }
      return true;
    }
    // Double rAF: the expand changes width + swaps abbreviated→full labels +
    // the active project auto-expands in the same commit; wait for layout to
    // settle before measuring. Retry one more frame if the row isn't in the DOM
    // yet (auto-expand may not have inserted it).
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        if (!snap()) raf3 = window.requestAnimationFrame(snap);
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
      window.cancelAnimationFrame(raf3);
    };
  }, [visible]);

  function toggleProj(id: string) {
    setOpenProj((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function isWorktreeActive(wtId: string): boolean {
    return (
      (activeWorktreeId === wtId && (location.pathname === "/worktree" || location.pathname.startsWith("/worktree/"))) ||
      location.pathname === `/worktree/${wtId}` ||
      location.pathname.startsWith(`/worktree/${wtId}/`)
    );
  }

  function selectWorktree(projectId: string, w: Worktree) {
    if (isWorktreeActive(w.id)) {
      setOpenWorktrees((prev) => {
        const next = new Set(prev);
        if (next.has(w.id)) next.delete(w.id);
        else next.add(w.id);
        return next;
      });
      onWorktreeSelected?.(w.id);
      return;
    }
    setActiveWorktree(projectId, w.id, sessionMap[w.id]);
    onWorktreeSelected?.(w.id);
  }

  function selectWorktreeAgent(projectId: string, w: Worktree, sessId: string) {
    if (activeWorktreeId !== w.id) {
      setActiveWorktree(projectId, w.id, sessionMap[w.id]);
    }
    setActiveSession(sessId);
    onWorktreeSelected?.(w.id);
  }

  // A modified click (ctrl/cmd/shift/alt or non-primary button) lets React
  // Router's <Link> fall through to the browser's default "open in new tab"
  // behavior without in-app navigation. We must NOT call selectWorktree() in
  // that case, otherwise the current tab would also navigate to the worktree.
  function isModifiedClick(e: React.MouseEvent) {
    return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
  }

  // ── Instant draft flow (Phase 2) ───────────────────────────────────────────
  // Tier 2 (global-new) draft lives in the reactive Zustand store so the
  // sidebar's top-level row and the DraftComposer both subscribe to it.
  const globalDraft = useGlobalDraftStore((s) => s.draft);
  const globalDraftClear = useGlobalDraftStore((s) => s.clearDraft);
  const globalDraftSet = useGlobalDraftStore((s) => s.setDraft);

  /** Navigate to a draft by id, closing any open plus menu first. */
  function gotoDraft(id: string) {
    setPlusMenu(null);
    navigate(`/draft/${id}`);
  }

  /** Global "+ Create new agent" → a FRESH Tier 2 draft at /draft/new.
   *  Always resets the slot — "new" should start empty, not re-focus whatever
   *  was left from a previous session (PRD journey 12). */
  function handleGlobalNewAgent() {
    if (isMobile) setMobileSidebarOpen(false);
    setDraftError(null);
    void (async () => {
      try {
        const s = await api.createDraftSession({
          target: "global",
          type: "agent",
          draftConfig: { entryPoint: "global" },
        });
        useServerStore.getState().applySessionCreated(s);
        gotoDraft(s.id);
      } catch (err) {
        setDraftError(err instanceof Error ? err.message : "Couldn't create a new draft. Please try again.");
      }
    })();
  }

  /** Project "+" → "Agent in worktree" → create a Tier 1 draft. */
  function handleNewWorktree(project: Project) {
    if (isMobile) setMobileSidebarOpen(false);
    setDraftError(null);
    void (async () => {
      try {
        // no worktree exists yet — the draft hangs off the project; the worktree is created on Start
        const s = await createProjectWorktreeDraft(api, project.id);
        gotoDraft(s.id);
      } catch (err) {
        setDraftError(err instanceof Error ? err.message : "Couldn't start a new draft. Please try again.");
      }
    })();
  }

  /** Project "+" → "Agent in project dir" → item 4: same draft-tab path as
   *  the project workspace's own "+"/"New direct agent" (`createProjectDirectDraft`,
   *  entryPoint "tab"), landing in the SAME tab + sidebar-highlighted state
   *  those produce, instead of the legacy full-page `/draft/:id` composer.
   *  Deliberately does NOT call `openProjectAgentTab` here — navigating first
   *  lets `useProjectWorkspaceUrlSync`'s read effect seed the project's other
   *  existing direct agents before this draft's own entry is added; opening
   *  the tab first would mark the project's open-tab-set non-empty and skip
   *  that seed. */
  function handleNewDirectAgent(project: Project) {
    if (isMobile) setMobileSidebarOpen(false);
    setDraftError(null);
    setPlusMenu(null);
    void (async () => {
      try {
        const s = await createProjectDirectDraft(api, project.id);
        setOpenDirectAgents((prev) => new Set(prev).add(project.id));
        navigate(`/project/${project.id}/${s.id}`);
      } catch (err) {
        setDraftError(err instanceof Error ? err.message : "Couldn't start a new draft. Please try again.");
      }
    })();
  }

  /** Discard a Tier 1 draft (server-backed session) — DELETE the record, and
   *  leave the draft route if we're currently viewing it. Item 4: a "tab"
   *  draft lives at `/project/:pid/:id` instead of `/draft/:id` — close its
   *  project-workspace tab and return to the project's Overview, mirroring
   *  `confirmTerminateSession`'s "leave before deletion" pattern above. */
  function confirmDiscardSession(s: Session) {
    if (s.draftConfig?.entryPoint === "tab" && s.projectId) {
      if (location.pathname === `/project/${s.projectId}/${s.id}`) {
        // Navigate to the same neighbor the store re-selects below (else the
        // project read effect, seeing no sessionId in the URL, nulls it).
        const openTabs = useWorkspaceStore.getState().openDirectAgentTabsByProject[s.projectId] ?? [];
        const next = pickNextDirectAgent(openTabs, s, sessions);
        navigate(next ? `/project/${s.projectId}/${next}` : `/project/${s.projectId}`, { replace: true });
      }
      // Re-selects the neighbor (or null → Project tab) if `s` was the active
      // direct agent.
      useWorkspaceStore.getState().closeProjectAgentTab(s.projectId, s.id, sessions);
    } else if (location.pathname === `/draft/${s.id}`) {
      navigate("/", { replace: true });
    }
    void (async () => {
      try {
        await api.terminateSession(s.id);
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "Failed to discard draft.");
      }
    })();
  }

  /** Discard the Tier 2 (global) draft — just clears the store. */
  function confirmDiscardGlobal() {
    globalDraftClear();
    if (location.pathname === "/draft/new") {
      navigate("/", { replace: true });
    }
  }

  function handleConfirmDiscardDraft() {
    if (!pendingDiscardDraft) return;
    if (pendingDiscardDraft.kind === "global") {
      confirmDiscardGlobal();
    } else {
      confirmDiscardSession(pendingDiscardDraft.session);
    }
    setPendingDiscardDraft(null);
  }

  /** Draft sessions (state === "drafting") under a given project, partitioned
   *  into direct drafts (entryPoint === "direct" OR a worktree-less "tab"
   *  draft — item 4's project-workspace draft tabs — merged into the direct
   *  session list) and worktree drafts (any other entry point, merged into
   *  the worktree list). A worktree-scope "tab" draft (has a `worktreeId`)
   *  stays excluded, same as before — it's the worktree TabsStrip's own tab,
   *  not a sidebar row. Both direct/worktree buckets render as Tier 1 draft
   *  rows inside their merged sortable scope, so a draft can be dragged among
   *  its non-draft siblings. */
  const draftsByProject = useMemo(() => {
    const m: Record<string, { direct: Session[]; worktree: Session[] }> = {};
    for (const s of sessions) {
      if (s.state !== "drafting" || !s.projectId) continue;
      const entryPoint = s.draftConfig?.entryPoint;
      if (entryPoint === "tab") {
        if (s.worktreeId != null) continue; // worktree-scope tab draft — not a sidebar row
        (m[s.projectId] ??= { direct: [], worktree: [] }).direct.push(s);
        continue;
      }
      const bucket = entryPoint === "direct" ? "direct" : "worktree";
      (m[s.projectId] ??= { direct: [], worktree: [] })[bucket].push(s);
    }
    return m;
  }, [sessions]);

  /** A "tab" draft's sidebar row (item 4) links into the project workspace
   *  tab, not the legacy full-page `/draft/:id` composer. */
  function draftRowHref(sess: Session): string {
    return sess.draftConfig?.entryPoint === "tab" && sess.projectId
      ? `/project/${sess.projectId}/${sess.id}`
      : `/draft/${sess.id}`;
  }

  const trimmedQuery = searchQuery.trim();

  // Reorder handlers (`handleReorder`, `reorderWorkspace`, `handleServerReorderMixed`)
  // all build their next-order payload from the currently RENDERED (filtered) list —
  // while a search is active that list excludes non-matching rows, so completing a
  // drag would silently push every hidden row to the end of the real order (found in
  // review). Simplest safe fix: no sensors means `useSortable`'s listeners never
  // activate, so a drag can't start at all while a query is active.
  const activeDndSensors = trimmedQuery ? [] : dndSensors;

  const matchText = useCallback(
    (text: string | null | undefined): boolean => {
      if (!text || !trimmedQuery) return false;
      return fuzzyScore(trimmedQuery, text) !== null;
    },
    [trimmedQuery],
  );

  const sessionMatchesQuery = useCallback(
    (s: Session): boolean => {
      if (!trimmedQuery) return true;
      // Deliberately NOT matching `s.id`/`s.modeId` — both are opaque hex-ish
      // strings, so a short query like "add" or "cafe" fuzzy-subsequence-matches
      // almost every row and floods the results (found in review).
      return matchText(sessionLabel(s)) || matchText(s.name);
    },
    [trimmedQuery, matchText],
  );

  const worktreeMatchesQuery = useCallback(
    (w: Worktree): boolean => {
      if (!trimmedQuery) return true;
      // `w.id` deliberately excluded — same id-flooding reasoning as `sessionMatchesQuery`.
      if (matchText(worktreeLabel(w)) || matchText(w.branch)) {
        return true;
      }
      const wtSessions = sessionMap[w.id] ?? [];
      return wtSessions.some(sessionMatchesQuery);
    },
    [trimmedQuery, matchText, sessionMap, sessionMatchesQuery],
  );

  const filteredPinnedItems = useMemo(() => {
    if (!trimmedQuery) return orderedPinnedItems;
    return orderedPinnedItems.filter((item) => {
      if (item.kind === "session") {
        const sess = item.data;
        const proj = sess.projectId != null ? projectById[sess.projectId] : undefined;
        return (
          sessionMatchesQuery(sess) ||
          matchText(proj?.name)
        );
      } else {
        const w = item.data;
        const proj = projectById[w.projectId];
        return (
          worktreeMatchesQuery(w) ||
          matchText(proj?.name)
        );
      }
    });
  }, [orderedPinnedItems, trimmedQuery, sessionMatchesQuery, worktreeMatchesQuery, matchText, projectById]);

  const showPinned = !collapsed && (trimmedQuery ? filteredPinnedItems.length > 0 : hasPinned);

  const filteredWorkspaces = useMemo(() => {
    if (!trimmedQuery) return orderedWorkspaces;
    return orderedWorkspaces.filter((ws) => matchText(ws.name));
  }, [orderedWorkspaces, trimmedQuery, matchText]);

  const projectDirectlyMatches = useCallback(
    (p: Project) => {
      if (!trimmedQuery) return true;
      return matchText(p.name); // `p.id` excluded — same id-flooding reasoning as above
    },
    [trimmedQuery, matchText],
  );

  const projectHasMatchingChild = useCallback(
    (p: Project) => {
      const directSessions = directSessionMap[p.id] ?? [];
      if (directSessions.some(sessionMatchesQuery)) return true;
      const directDrafts = draftsByProject[p.id]?.direct ?? [];
      if (directDrafts.some((d) => matchText(d.name) || matchText(draftLabel(d.draftPrompt)))) return true;
      const wtList = worktreeMap[p.id] ?? [];
      if (wtList.some(worktreeMatchesQuery)) return true;
      const wtDrafts = draftsByProject[p.id]?.worktree ?? [];
      if (wtDrafts.some((d) => matchText(d.name) || matchText(draftLabel(d.draftPrompt)))) return true;
      return false;
    },
    [directSessionMap, sessionMatchesQuery, draftsByProject, matchText, worktreeMap, worktreeMatchesQuery],
  );

  const projectMatchesQuery = useCallback(
    (p: Project) => {
      if (!trimmedQuery) return true;
      return projectDirectlyMatches(p) || projectHasMatchingChild(p);
    },
    [trimmedQuery, projectDirectlyMatches, projectHasMatchingChild],
  );

  const filteredTopLevelItems = useMemo(() => {
    if (!trimmedQuery) return orderedTopLevelItems;
    return orderedTopLevelItems.filter((item) => {
      if (item.kind === "global_draft") {
        const s = item.data;
        return matchText(s.name) || matchText(draftLabel(s.draftPrompt));
      }
      return projectMatchesQuery(item.data);
    });
  }, [orderedTopLevelItems, trimmedQuery, matchText, projectMatchesQuery]);

  return (
    <div
      className={`left-sidebar ${collapsed ? "left-sidebar--collapsed" : ""}`}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      {header}
      <div
        ref={scrollRef}
        className={collapsed ? "left-sidebar__scroll" : "left-sidebar__scroll scroll-stable"}
        style={{ flex: 1, overflow: "auto", padding: collapsed ? "var(--space-1)" : "var(--space-2)" }}
      >
        <div className="left-sidebar__brand">
          {!collapsed ? (
            <div className="left-sidebar__brand-inner">
              <span className="left-sidebar__brand-name" aria-hidden>Vibe Station</span>
              <Logo size={11} />
              <span className="left-sidebar__brand-version" aria-hidden>v{pkgJson.version}</span>
              <a
                href="https://github.com/fastestdevalive/vibe-station"
                target="_blank"
                rel="noopener noreferrer"
                className="left-sidebar__brand-github"
                aria-label="View on GitHub"
                title="View on GitHub"
              >
                <Github size={12} />
              </a>
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <Link
            to="/"
            className="left-sidebar__nav-item"
            aria-label="Home"
            onClick={() => {
              clearWorkspaceSelection();
              if (isMobile) setMobileSidebarOpen(false);
            }}
          >
            <Home size={16} />
            {!collapsed ? "Home" : null}
          </Link>
          <button
            type="button"
            className="left-sidebar__nav-item"
            aria-label="Create new agent"
            title="Create new agent"
            onClick={handleGlobalNewAgent}
          >
            <Plus size={16} aria-hidden />
            {!collapsed ? "Create new agent" : null}
          </button>
          {!collapsed ? (
            <label className="sidebar-search">
              <span className="sidebar-search__icon" aria-hidden>
                <MaterialSearchIcon size={16} />
              </span>
              <input
                type="text"
                className="sidebar-search__input"
                placeholder={searchOpen ? "Search sessions, worktrees..." : "Search"}
                aria-label="Search sidebar"
                value={searchQuery}
                onFocus={() => setSearchOpen(true)}
                onBlur={() => setSearchOpen(false)}
                onChange={(e) => handleSearchChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    handleSearchChange("");
                    e.currentTarget.blur();
                  }
                }}
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="sidebar-search__clear"
                  aria-label="Clear search"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleSearchChange("")}
                >
                  <X size={12} />
                </button>
              ) : null}
            </label>
          ) : null}
        </div>
        {!collapsed ? <div className="sidebar-section-divider" aria-hidden /> : null}
        {!collapsed && showPinned ? (
          <section className="pinned-section" aria-label="Pinned">
            <div className="sidebar-projects-heading pinned-section__heading">
              <span className="sidebar-projects-heading__gutter" aria-hidden />
              <button
                type="button"
                className="tree-row__project-expand"
                style={{ flex: 1 }}
                aria-expanded={pinnedOpen}
                aria-label={`${pinnedOpen ? "Collapse" : "Expand"} Pinned`}
                onClick={() => setPinnedOpen((v) => !v)}
              >
                <span
                  className={`sidebar-projects-heading__icon pinned-section__pin${pinnedOpen ? "" : " pinned-section__pin--closed"}`}
                  aria-hidden
                >
                  <Pin size={12} />
                </span>
                <span className="sidebar-projects-heading__title">Pinned</span>
              </button>
            </div>
            {pinnedOpen ? (
            <DndContext
              sensors={activeDndSensors}
              collisionDetection={closestCenter}
              onDragStart={markDrag}
              onDragCancel={markDrag}
              onDragEnd={(e) =>
                handleReorder(
                  "pinned-all",
                  filteredPinnedItems.map((x) => x.id),
                  e,
                )
              }
            >
              <SortableContext
                items={filteredPinnedItems.map((x) => x.id)}
                strategy={verticalListSortingStrategy}
              >
                {filteredPinnedItems.map((item) => {
                  if (item.kind === "session") {
                    const sess = item.data;
                    const proj = sess.projectId != null ? projectById[sess.projectId] : undefined;
                    const isActive = location.pathname === `/project/${sess.projectId}/${sess.id}`;
                    const label = sessionLabel(sess);
                    return (
                      <SortableRow key={`pinned-sess-${sess.id}`} id={sess.id}>
                        {({ setNodeRef, style, attributes, listeners }) => (
                          <div
                            ref={setNodeRef}
                            style={style}
                            className="wt-row-wrap"
                            {...attributes}
                            {...listeners}
                          >
                            <div
                              className="tree-row tree-row--direct-session pinned-row"
                              data-active={isActive}
                              data-archived={sess.archivedAt != null ? "true" : undefined}
                              style={{ position: "relative" }}
                              title={`${label} — direct session`}
                              onClickCapture={suppressDoubleClickNavigation}
                              onDoubleClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                startInlineRename("session", sess.id, label, "pinned");
                              }}
                            >
                              <Link
                                to={`/project/${sess.projectId}/${sess.id}`}
                                className="wt-row__stretch-link"
                                draggable={false}
                                aria-label={`Open pinned direct session ${label}`}
                                onClick={() => {
                                  if (isMobile) setMobileSidebarOpen(false);
                                }}
                                tabIndex={-1}
                              />
                              <span className="wt-leading-slot pinned-row__leading">
                                <StatusDot
                                  status={sessionStateToStatus(sessionStates[sess.id] ?? sess.state)}
                                  // Direct session — no worktree to branch-guard a PR against, so
                                  // it can never show one (docs/STATUS-INDICATORS.md).
                                  pr={null}
                                />
                              </span>
                              <div className="pinned-row__text">
                                {inlineRename?.kind === "session" &&
                                inlineRename.id === sess.id &&
                                inlineRename.site === "pinned" ? (
                                  <input
                                    ref={inlineInputRef}
                                    className="pinned-row__primary pinned-row__rename-input"
                                    aria-label="Rename"
                                    value={inlineValue}
                                    autoFocus
                                    onClick={(e) => e.stopPropagation()}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onChange={(e) => setInlineValue(e.target.value)}
                                    onBlur={commitInlineRename}
                                    onKeyDown={(e) => {
                                      e.stopPropagation();
                                      if (e.key === "Enter") { e.preventDefault(); commitInlineRename(); }
                                      if (e.key === "Escape") { e.preventDefault(); setInlineRename(null); }
                                    }}
                                    maxLength={60}
                                  />
                                ) : (
                                  <span className="pinned-row__primary">{label}</span>
                                )}
                                <span className="pinned-row__subhead" title={proj?.path}>
                                  {proj?.name ?? sess.projectId}
                                </span>
                              </div>
                              <div className="wt-row__trail pinned-row__trail" style={{ position: "relative", zIndex: 2 }}>
                                {sess.archivedAt != null ? (
                                  <span className="direct-session__badge">archived</span>
                                ) : null}
                                <span className="direct-session__badge">direct</span>
                                <button
                                  type="button"
                                  data-sess-menu-trigger
                                  className="icon-btn wt-menu-trigger tree-row__action"
                                  aria-label={`Session actions for ${label}`}
                                  aria-expanded={sessMenu?.session.id === sess.id}
                                  aria-haspopup="menu"
                                  title="Session menu"
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    setSessMenu((prev) =>
                                      prev?.session.id === sess.id ? null : { session: sess, rect },
                                    );
                                  }}
                                >
                                  <MoreHorizontal size={16} />
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </SortableRow>
                    );
                  } else {
                    const w = item.data;
                    const proj = projectById[w.projectId];
                    const isActive = activeWorktreeId === w.id && location.pathname.startsWith("/worktree/");
                    const label = worktreeLabel(w);
                    return (
                      <SortableRow key={`pinned-${w.id}`} id={w.id}>
                        {({ setNodeRef, style, attributes, listeners }) => (
                          <div
                            ref={setNodeRef}
                            style={style}
                            className="wt-row-wrap"
                            {...attributes}
                            {...listeners}
                          >
                            <div
                              className="tree-row tree-row--worktree pinned-row"
                              data-active={isActive}
                              style={{ position: "relative" }}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  selectWorktree(w.projectId, w);
                                }
                              }}
                              onClickCapture={suppressDoubleClickNavigation}
                              onDoubleClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                startInlineRename("worktree", w.id, label, "pinned");
                              }}
                            >
                              <Link
                                to={`/worktree/${w.id}`}
                                className="wt-row__stretch-link"
                                draggable={false}
                                aria-label={`Open pinned worktree ${label}`}
                                onClick={(e) => {
                                  if (isModifiedClick(e)) return;
                                  selectWorktree(w.projectId, w);
                                }}
                                tabIndex={-1}
                              />
                              <span className="wt-leading-slot pinned-row__leading">
                                <StatusDot
                                  status={worktreeRolledUpStatus(sessionMap[w.id] ?? [], sessionStates)}
                                  pr={worktreePrStatus(sessionMap[w.id] ?? [], w.branch)}
                                />
                              </span>
                              <div className="pinned-row__text">
                                {inlineRename?.kind === "worktree" &&
                                inlineRename.id === w.id &&
                                inlineRename.site === "pinned" ? (
                                  <input
                                    ref={inlineInputRef}
                                    className="pinned-row__primary pinned-row__rename-input"
                                    aria-label="Rename"
                                    value={inlineValue}
                                    autoFocus
                                    onClick={(e) => e.stopPropagation()}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onChange={(e) => setInlineValue(e.target.value)}
                                    onBlur={commitInlineRename}
                                    onKeyDown={(e) => {
                                      e.stopPropagation();
                                      if (e.key === "Enter") { e.preventDefault(); commitInlineRename(); }
                                      if (e.key === "Escape") { e.preventDefault(); setInlineRename(null); }
                                    }}
                                    maxLength={60}
                                  />
                                ) : (
                                  <span className="pinned-row__primary">{label}</span>
                                )}
                                <span className="pinned-row__subhead" title={proj?.path}>
                                  {proj?.name ?? w.projectId}
                                </span>
                              </div>
                              <div className="wt-row__trail pinned-row__trail" style={{ position: "relative", zIndex: 2 }}>
                                <DiffStatBadge stat={diffStats[w.id] ?? null} />
                                <span className="wt-row__id" title={w.id}>
                                  {w.id}
                                </span>
                                <button
                                  type="button"
                                  data-wt-menu-trigger
                                  className="icon-btn wt-menu-trigger tree-row__action"
                                  aria-label={`Worktree actions for ${label}`}
                                  aria-expanded={wtMenu?.worktree.id === w.id}
                                  aria-haspopup="menu"
                                  title="Worktree menu"
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    setWtMenu((prev) =>
                                      prev?.worktree.id === w.id
                                        ? null
                                        : { projectId: w.projectId, worktree: w, rect },
                                    );
                                  }}
                                >
                                  <MoreHorizontal size={16} />
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </SortableRow>
                    );
                  }
                })}
              </SortableContext>
            </DndContext>
            ) : null}
          </section>
        ) : null}
        {!collapsed && showPinned ? <div className="sidebar-section-divider" aria-hidden /> : null}
        {/* Saved workspace layouts (tiled/free-form pane arrangements) — GLOBAL,
            listed regardless of which worktree (or none) is currently active;
            a saved workspace is detached from its creating worktree (Phase 3,
            Decision 4/6). Reorder + rename are both purely client-side (no
            daemon route exists for WorkspaceDoc). */}
        {!collapsed ? (
          <section className="workspaces-section" aria-label="Workspaces">
            <div className="sidebar-projects-heading pinned-section__heading">
              <span className="sidebar-projects-heading__gutter" aria-hidden />
              <button
                type="button"
                className="tree-row__project-expand"
                style={{ flex: 1 }}
                aria-expanded={workspacesOpen}
                aria-label={`${workspacesOpen ? "Collapse" : "Expand"} Workspaces`}
                onClick={() => setWorkspacesOpen((v) => !v)}
              >
                <span className="tree-row__chevron" aria-hidden>
                  {workspacesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                <span className="sidebar-projects-heading__title">Workspaces</span>
              </button>
            </div>
            {workspacesOpen ? (
              filteredWorkspaces.length === 0 ? (
                <div
                  className="empty-state"
                  style={{ padding: "var(--space-2) var(--space-3)", opacity: 0.6 }}
                >
                  {trimmedQuery ? "No matching workspaces" : "No workspaces yet"}
                </div>
              ) : (
                <DndContext
                  sensors={activeDndSensors}
                  collisionDetection={closestCenter}
                  onDragStart={markDrag}
                  onDragCancel={markDrag}
                  onDragEnd={(e) =>
                    handleWorkspaceReorder(
                      workspacesScopeKey,
                      filteredWorkspaces.map((d) => d.id),
                      e,
                    )
                  }
                >
                  <SortableContext
                    items={filteredWorkspaces.map((d) => d.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {filteredWorkspaces.map((ws) => {
                      const isActive = activeDetachedWorkspaceId === ws.id;
                      return (
                        <SortableRow key={ws.id} id={ws.id}>
                          {({ setNodeRef, style, attributes, listeners }) => (
                            <div
                              ref={setNodeRef}
                              style={style}
                              className="wt-row-wrap"
                              {...attributes}
                              {...listeners}
                            >
                              <div
                                className="tree-row tree-row--worktree"
                                data-active={isActive}
                                style={{ position: "relative" }}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    if (isMobile) setMobileSidebarOpen(false);
                                    navigate(`/workspaces/${ws.id}`);
                                  }
                                }}
                                onClick={() => {
                                  if (isMobile) setMobileSidebarOpen(false);
                                  navigate(`/workspaces/${ws.id}`);
                                }}
                                onDoubleClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  startInlineRename("workspace", ws.id, ws.name, "tree");
                                }}
                              >
                                <div className="wt-row__expand">
                                  {inlineRename?.kind === "workspace" &&
                                  inlineRename.id === ws.id &&
                                  inlineRename.site === "tree" ? (
                                    <input
                                      ref={inlineInputRef}
                                      className="wt-row__label wt-row__rename-input"
                                      aria-label="Rename"
                                      value={inlineValue}
                                      autoFocus
                                      onClick={(e) => e.stopPropagation()}
                                      onPointerDown={(e) => e.stopPropagation()}
                                      onChange={(e) => setInlineValue(e.target.value)}
                                      onBlur={commitInlineRename}
                                      onKeyDown={(e) => {
                                        e.stopPropagation();
                                        if (e.key === "Enter") { e.preventDefault(); commitInlineRename(); }
                                        if (e.key === "Escape") { e.preventDefault(); setInlineRename(null); }
                                      }}
                                      maxLength={60}
                                    />
                                  ) : (
                                    <span className="wt-row__label">{ws.name}</span>
                                  )}
                                </div>
                                <div className="wt-row__trail" style={{ position: "relative", zIndex: 2 }}>
                                  <button
                                    type="button"
                                    className="icon-btn wt-menu-trigger tree-row__action"
                                    aria-label={`Delete workspace ${ws.name}`}
                                    title="Delete workspace"
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      setPendingDeleteWorkspace(ws);
                                    }}
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </SortableRow>
                      );
                    })}
                  </SortableContext>
                </DndContext>
              )
            ) : null}
          </section>
        ) : null}
        {!collapsed ? <div className="sidebar-section-divider" aria-hidden /> : null}
        <div className="sidebar-projects-heading">
          <span className="sidebar-projects-heading__gutter" aria-hidden />
          {collapsed ? null : (
            <>
              <span className="sidebar-projects-heading__icon" aria-hidden>
                <FolderTree size={12} />
              </span>
              <span className="sidebar-projects-heading__title">Projects</span>
              <button
                type="button"
                data-filter-menu-trigger
                className="icon-btn"
                title={hideInactiveWorktrees ? "Showing active only" : "Filter worktrees"}
                aria-label="Filter worktrees"
                aria-pressed={hideInactiveWorktrees}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setFilterMenuRect((r) => (r ? null : rect));
                }}
              >
                <Filter
                  size={13}
                  fill={hideInactiveWorktrees ? "currentColor" : "none"}
                  color={hideInactiveWorktrees ? "var(--accent-color, var(--accent))" : undefined}
                />
              </button>
              <button
                type="button"
                className="icon-btn sidebar-projects-heading__add"
                title="New project"
                aria-label="New project"
                onClick={handleGlobalNewAgent}
              >
                <FolderPlus size={14} />
              </button>
            </>
          )}
        </div>
        {!collapsed && draftError ? (
          <div className="sidebar-inline-error" role="status">
            <span>{draftError}</span>
            <button type="button" className="icon-btn" aria-label="Dismiss error" onClick={() => setDraftError(null)}>×</button>
          </div>
        ) : null}
        {/* Tier 2 draft row (global new — no project chosen yet) — a top-level
            sibling to projects, rendered while a global draft is in the store. */}
        {!collapsed && globalDraft && (!trimmedQuery || matchText(draftLabel(globalDraft.draftPrompt)) || matchText(globalDraft.draftPrompt)) ? (
          <div
            className="tree-row tree-row--project draft-row"
            data-active={location.pathname === "/draft/new"}
            style={{ position: "relative" }}
          >
            <Link to="/draft/new" className="wt-row__stretch-link" draggable={false} tabIndex={-1} />
            {/* Mirror the project main structure so icon+label expands and matches project rows. */}
            <div className="tree-row__project-main" style={{ pointerEvents: "none" }}>
              <span className="tree-row__project-chevron" aria-hidden>
                <Folder size={14} />
              </span>
              <span className="tree-row__label draft-row__label">{draftLabel(globalDraft.draftPrompt)}</span>
            </div>
            <div className="wt-row__trail draft-row__trail">
              <span className="draft-chip">Draft</span>
              <button
                type="button"
                className="draft-row__discard icon-btn"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setPendingDiscardDraft({ kind: "global" });
                }}
                title="Discard draft"
              >
                ×
              </button>
            </div>
          </div>
        ) : null}
        {visibleProjects.length === 0 ? (
          <div className={`empty-state ${collapsed ? "empty-state--collapsed-rail" : ""}`} style={{ padding: collapsed ? "var(--space-2)" : "var(--space-4)" }}>
            {collapsed ? (
              <span title="No projects yet — click + to add one">∅</span>
            ) : (
              "No projects yet."
            )}
          </div>
        ) : !collapsed && trimmedQuery && filteredTopLevelItems.length === 0 ? (
          <div className="empty-state" style={{ padding: "var(--space-4)" }}>
            No matching projects or sessions
          </div>
        ) : null}
        {collapsed ? (
          <CollapsedProjectRail
            projects={orderedTopLevelItems.flatMap((x) => (x.kind === "project" ? [x.data] : []))}
            pinnedItems={orderedPinnedItems}
            workspaces={orderedWorkspaces}
            projectById={projectById}
            worktreeMap={worktreeMap}
            directSessionMap={directSessionMap}
            sessionMap={sessionMap}
            sessionStates={sessionStates}
            activeProjectId={activeProjectId}
            onSelectProject={(p) => setOpenProj((prev) => new Set(prev).add(p.id))}
            onSelectWorktree={(p, w) => selectWorktree(p.id, w)}
            onNewSession={(project, rect) => setPlusMenu({ project, rect })}
          />
        ) : (
        <DndContext
          sensors={activeDndSensors}
          collisionDetection={closestCenter}
          onDragStart={markDrag}
          onDragCancel={markDrag}
          onDragEnd={handleTopLevelReorder}
        >
        <SortableContext
          items={filteredTopLevelItems.map((x) => x.id)}
          strategy={verticalListSortingStrategy}
        >
        {filteredTopLevelItems.map((item) => {
          if (item.kind === "global_draft") {
            const s = item.data;
            return (
              <SortableRow key={s.id} id={s.id}>
                {({ setNodeRef, style, attributes, listeners }) => (
                  <div ref={setNodeRef} style={style} className="wt-row-wrap" {...attributes} {...listeners}>
                    <div
                      className="tree-row tree-row--project draft-row"
                      data-active={location.pathname === `/draft/${s.id}`}
                      style={{ position: "relative" }}
                    >
                      <Link to={`/draft/${s.id}`} className="wt-row__stretch-link" draggable={false} tabIndex={-1} />
                      <div className="tree-row__project-main" style={{ pointerEvents: "none" }}>
                        <span className="tree-row__project-chevron" aria-hidden>
                          <Folder size={14} />
                        </span>
                        <span className="tree-row__label draft-row__label">{s.name?.trim() || draftLabel(s.draftPrompt)}</span>
                      </div>
                      <div className="wt-row__trail draft-row__trail">
                        <span className="draft-chip">Draft</span>
                        <button
                          type="button"
                          className="draft-row__discard icon-btn"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setPendingDiscardDraft({ kind: "session", session: s });
                          }}
                          title="Discard draft"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </SortableRow>
            );
          }
          const p = item.data;
          return (
          <SortableRow key={p.id} id={p.id}>
          {({ setNodeRef, style, attributes, listeners }) => (
          <div ref={setNodeRef} style={style} className="wt-row-wrap" {...attributes}>
            <div
              className="tree-row tree-row--project"
              style={{ position: "relative" }}
              /* Item 3 (round 2): the project row itself had no active-state
                 signal at all — only individual session rows got one — so
                 selecting the bare Overview tab (no session, activeSessionId
                 == null) highlighted the tab strip but left the sidebar's
                 project row looking unselected. `.tree-row[data-active]`
                 already has generic highlight CSS (workspace.css:1999); just
                 supplying the attribute here reuses it with no new rules. */
              data-active={location.pathname === `/project/${p.id}`}
              /* The stretch-link below is tabIndex={-1} (same full-row overlay
                 pattern as every other row), so give the row itself the
                 keyboard route to the project Overview — matching how the
                 worktree rows are keyboard-reachable (role="button" +
                 tabIndex={0}, Enter/Space activates). */
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (location.pathname === `/project/${p.id}`) {
                    toggleProj(p.id);
                  } else {
                    navigate(`/project/${p.id}`);
                    setOpenProj((prev) => new Set(prev).add(p.id));
                    if (isMobile) setMobileSidebarOpen(false);
                  }
                }
              }}
              {...listeners}
            >
              {/* Item 5: a full-row stretch link (same pattern as the direct-
                  session/draft rows), instead of a link wrapping only the
                  name text — the name-only link's hit area was one line
                  tall, so tapping a few px above/below it (still inside the
                  visually clickable row) did nothing. The folder toggle,
                  "+" and "⋯" buttons sit above this via z-index so they stay
                  independently clickable. */}
              <Link
                to={`/project/${p.id}`}
                className="wt-row__stretch-link"
                aria-label={`Open project ${p.name}`}
                draggable={false}
                tabIndex={-1}
                onClickCapture={suppressDoubleClickNavigation}
                onClick={(e) => {
                  if (location.pathname === `/project/${p.id}`) {
                    e.preventDefault();
                    toggleProj(p.id);
                    return;
                  }
                  setOpenProj((prev) => new Set(prev).add(p.id));
                  if (isMobile) setMobileSidebarOpen(false);
                }}
              />
              <div className="tree-row__project-main">
                <button
                  type="button"
                  className="tree-row__project-expand"
                  aria-expanded={openProj.has(p.id)}
                  aria-label={`${openProj.has(p.id) ? "Collapse" : "Expand"} project ${p.name}`}
                  title={
                    collapsed
                      ? `${p.name} — ${openProj.has(p.id) ? "Click to hide worktrees" : "Click to show worktrees"}`
                      : undefined
                  }
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleProj(p.id);
                  }}
                >
                  <span className="tree-row__chevron tree-row__project-chevron" aria-hidden>
                    {openProj.has(p.id) ? <FolderOpen size={14} /> : <Folder size={14} />}
                  </span>
                </button>
                <span className="tree-row__label">
                  {collapsed ? disambiguatedAbbrev(p.name, p.id, visibleProjects) : p.name}
                </span>
              </div>
              <button
                type="button"
                data-plus-menu-trigger
                className="icon-btn tree-row__action"
                aria-label={`New session in ${p.name}`}
                aria-haspopup="menu"
                aria-expanded={plusMenu?.project.id === p.id}
                title={collapsed ? `New session — ${p.name}` : undefined}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setPlusMenu((prev) =>
                    prev?.project.id === p.id ? null : { project: p, rect },
                  );
                }}
              >
                <Plus size={16} />
              </button>
              {!collapsed ? (
                <button
                  type="button"
                  data-proj-menu-trigger
                  className="icon-btn tree-row__action"
                  aria-label={`Project actions for ${p.name}`}
                  aria-expanded={projMenu?.project.id === p.id}
                  aria-haspopup="menu"
                  title="Project menu"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setProjMenu((prev) =>
                      prev?.project.id === p.id ? null : { project: p, rect },
                    );
                  }}
                >
                  <MoreHorizontal size={16} />
                </button>
              ) : null}
            </div>
            {/* Direct sessions (no worktree) + direct drafts (entryPoint ===
                "direct") — shown first, above worktrees. Both are Session
                objects sharing one reorder scope (`direct:${projectId}`);
                drafting sessions render as draft rows, the rest as direct
                session rows. */}
            {openProj.has(p.id)
              ? (() => {
                  // Real server `sortOrder` (Part 03 Decision 1) — no more
                  // local drag-order array for this (non-pinned) scope.
                  const directItems = [
                    ...(directSessionMap[p.id] ?? []),
                    ...(draftsByProject[p.id]?.direct ?? []),
                  ].filter((s) => {
                    if (!trimmedQuery || projectDirectlyMatches(p)) return true;
                    if (s.state === "drafting") {
                      return matchText(s.name) || matchText(draftLabel(s.draftPrompt));
                    }
                    return sessionMatchesQuery(s);
                  });
                  if (directItems.length === 0) return null;
                  const isExpanded = collapsed || openDirectAgents.has(p.id) || (trimmedQuery.length > 0);
                  const count = directItems.length;
                  const label = `${count} ${count === 1 ? "direct agent" : "direct agents"}`;
                  const orderedDirect = directItems.slice().sort((a, b) => {
                    const ao = a.sortOrder ?? 0;
                    const bo = b.sortOrder ?? 0;
                    if (ao !== bo) return ao - bo;
                    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
                  });
                  const orderedIds = orderedDirect.map((s) => s.id);
                  return (
                    <div className="direct-sessions-wrapper">
                      {!collapsed ? (
                        <div
                          className="tree-row tree-row--group-header tree-row--direct-agents-header"
                          role="button"
                          tabIndex={0}
                          aria-expanded={isExpanded}
                          aria-label={`${isExpanded ? "Collapse" : "Expand"} direct agents for ${p.name}`}
                          onClick={() => toggleDirectAgents(p.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleDirectAgents(p.id);
                            }
                          }}
                        >
                          <span className="tree-row__group-title">{label}</span>
                          <span className="tree-row__chevron" aria-hidden>
                            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </span>
                        </div>
                      ) : null}
                      {isExpanded ? (
                        <div className="direct-sessions-group">
                          <DndContext
                            sensors={activeDndSensors}
                            collisionDetection={closestCenter}
                            onDragStart={markDrag}
                            onDragCancel={markDrag}
                            onDragEnd={(e) => handleServerReorder(orderedDirect, "session", e)}
                          >
                            <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
                          {orderedDirect.map((sess) => {
                            if (sess.state === "drafting") {
                              return (
                                <SortableRow key={sess.id} id={sess.id}>
                                  {({ setNodeRef, style, attributes, listeners }) => (
                                    <div
                                      ref={setNodeRef}
                                      style={style}
                                      className="wt-row-wrap"
                                      {...attributes}
                                      {...listeners}
                                    >
                                      <div
                                        className="tree-row tree-row--direct-session draft-row"
                                        data-active={location.pathname === draftRowHref(sess)}
                                        style={{ position: "relative" }}
                                        title={sess.name?.trim() || draftLabel(sess.draftPrompt)}
                                      >
                                        <Link
                                          to={draftRowHref(sess)}
                                          className="wt-row__stretch-link"
                                          draggable={false}
                                          tabIndex={-1}
                                          onClick={() => { if (isMobile) setMobileSidebarOpen(false); }}
                                        />
                                        <div className="wt-row__expand">
                                          <span className="wt-leading-slot">
                                            <Bot size={10} aria-hidden />
                                          </span>
                                          <span className="wt-row__label draft-row__label">{sess.name?.trim() || draftLabel(sess.draftPrompt)}</span>
                                        </div>
                                        <div className="wt-row__trail draft-row__trail">
                                          <span className="draft-chip">Draft</span>
                                          <button
                                            type="button"
                                            className="draft-row__discard icon-btn tree-row__action"
                                            onPointerDown={(e) => e.stopPropagation()}
                                            onClick={(e) => {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              setPendingDiscardDraft({ kind: "session", session: sess });
                                            }}
                                            title="Discard draft"
                                          >
                                            ×
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </SortableRow>
                              );
                            }
                            const label = sessionLabel(sess);
                            return (
                              <SortableRow key={sess.id} id={sess.id}>
                                {({ setNodeRef, style, attributes, listeners }) => (
                                  <div
                                    ref={setNodeRef}
                                    style={style}
                                    className="wt-row-wrap"
                                    {...attributes}
                                    {...listeners}
                                  >
                                    <div
                                      className="tree-row tree-row--direct-session"
                                      data-active={location.pathname === `/project/${sess.projectId}/${sess.id}`}
                                      data-archived={sess.archivedAt != null ? "true" : undefined}
                                      style={{ position: "relative" }}
                                      title={collapsed ? `${label} — direct session` : "Direct session (no worktree)"}
                                      onClickCapture={suppressDoubleClickNavigation}
                                      onDoubleClick={(e) => {
                                        if (collapsed) return;
                                        e.preventDefault();
                                        e.stopPropagation();
                                        startInlineRename("session", sess.id, label, "tree");
                                      }}
                                    >
                                      <Link
                                        to={`/project/${sess.projectId}/${sess.id}`}
                                        className="wt-row__stretch-link"
                                        draggable={false}
                                        aria-label={`Open direct session ${label}`}
                                        onClick={() => {
                                          if (isMobile) setMobileSidebarOpen(false);
                                        }}
                                        tabIndex={-1}
                                      />
                                      <span className="direct-session__icon">
                                        <StatusDot
                                          status={sessionStateToStatus(sessionStates[sess.id] ?? sess.state)}
                                          // Direct session — no worktree to branch-guard a PR
                                          // against, so it can never show one
                                          // (docs/STATUS-INDICATORS.md).
                                          pr={null}
                                        />
                                      </span>
                                      {!collapsed ? (
                                        <SidebarSessionModeIcon session={sess} api={api} />
                                      ) : null}
                                      {!collapsed &&
                                      inlineRename?.kind === "session" &&
                                      inlineRename.id === sess.id &&
                                      inlineRename.site === "tree" ? (
                                        <input
                                          ref={inlineInputRef}
                                          className="direct-session__label direct-session__rename-input"
                                          aria-label="Rename"
                                          value={inlineValue}
                                          autoFocus
                                          onClick={(e) => e.stopPropagation()}
                                          onPointerDown={(e) => e.stopPropagation()}
                                          onChange={(e) => setInlineValue(e.target.value)}
                                          onBlur={commitInlineRename}
                                          onKeyDown={(e) => {
                                            e.stopPropagation();
                                            if (e.key === "Enter") { e.preventDefault(); commitInlineRename(); }
                                            if (e.key === "Escape") { e.preventDefault(); setInlineRename(null); }
                                          }}
                                          maxLength={60}
                                        />
                                      ) : (
                                        <span className="direct-session__label">
                                          {/* `slot` is gone (Decision 1) — collapsed view now shows a
                                              truncated label instead of a stable short code. */}
                                          {collapsed ? label.slice(0, 3) : label}
                                        </span>
                                      )}
                                      {!collapsed && sess.pinnedAt ? (
                                        <Pin size={10} fill="currentColor" aria-label="Pinned" style={{ flexShrink: 0, opacity: 0.7 }} />
                                      ) : null}
                                      {!collapsed && sess.archivedAt != null ? (
                                        <span className="direct-session__badge">archived</span>
                                      ) : null}
                                      {!collapsed && (
                                        <span className="direct-session__badge">direct</span>
                                      )}
                                      {!collapsed ? (
                                        <div className="wt-row__trail" style={{ position: "relative", zIndex: 2 }}>
                                          <button
                                            type="button"
                                            data-sess-menu-trigger
                                            className="icon-btn wt-menu-trigger tree-row__action"
                                            aria-label={`Session actions for ${label}`}
                                            aria-haspopup="menu"
                                            aria-expanded={sessMenu?.session.id === sess.id}
                                            title="Session menu"
                                            onPointerDown={(e) => e.stopPropagation()}
                                            onClick={(e) => {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              const rect = e.currentTarget.getBoundingClientRect();
                                              setSessMenu((prev) =>
                                                prev?.session.id === sess.id ? null : { session: sess, rect },
                                              );
                                            }}
                                          >
                                            <MoreHorizontal size={16} />
                                          </button>
                                        </div>
                                      ) : null}
                                    </div>
                                  </div>
                                )}
                              </SortableRow>
                            );
                          })}
                        </SortableContext>
                      </DndContext>
                    </div>
                  ) : null}
                </div>
              );
            })()
          : null}
            {/* Worktrees + worktree drafts (entryPoint !== "direct") — shown
                after direct sessions. Unified reorder scope (`worktrees:${projectId}`):
                worktrees and worktree drafts sort together by sortOrder in a
                single DndContext/SortableContext, so a draft can be dragged
                among its non-draft worktree siblings. */}
            {openProj.has(p.id)
              ? (() => {
                  const wtList = (worktreeMap[p.id] ?? []).filter((w) => {
                    if (hideInactiveWorktrees) {
                      const ss = sessionMap[w.id] ?? [];
                      if (worktreeIsInactive(ss, sessionStates)) return false;
                    }
                    if (!trimmedQuery || projectDirectlyMatches(p)) return true;
                    return worktreeMatchesQuery(w);
                  });
                  const wtDrafts = (draftsByProject[p.id]?.worktree ?? []).filter((s) => {
                    if (!trimmedQuery || projectDirectlyMatches(p)) return true;
                    return matchText(s.name) || matchText(draftLabel(s.draftPrompt));
                  });
                  if (wtList.length === 0 && wtDrafts.length === 0) return null;
                  // Real server `sortOrder` (Part 03 Decision 1) — no more
                  // local drag-order array for this (non-pinned) scope. Sort
                  // worktrees and worktree drafts together.
                  const projectItems: ProjectWorktreeItem[] = [
                    ...wtList.map((w) => ({ kind: "worktree" as const, data: w, id: w.id, sortOrder: w.sortOrder })),
                    ...wtDrafts.map((s) => ({ kind: "draft" as const, data: s, id: s.id, sortOrder: s.sortOrder })),
                  ];
                  const orderedItems = projectItems.slice().sort((a, b) => {
                    const ao = a.sortOrder ?? 0;
                    const bo = b.sortOrder ?? 0;
                    if (ao !== bo) return ao - bo;
                    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
                  });
                  const orderedIds = orderedItems.map((x) => x.id);
                  const orderedWtList = orderedItems
                    .filter((x): x is Extract<ProjectWorktreeItem, { kind: "worktree" }> => x.kind === "worktree")
                    .map((x) => x.data);
                  return (
                    <DndContext
                      sensors={activeDndSensors}
                      collisionDetection={closestCenter}
                      onDragStart={markDrag}
                      onDragCancel={markDrag}
                      onDragEnd={(e) => handleServerReorderMixed(orderedItems, e)}
                    >
                      <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
                        {orderedItems.map((item) => {
                          if (item.kind === "draft") {
                            const s = item.data;
                            return (
                              <SortableRow key={s.id} id={s.id}>
                                {({ setNodeRef, style, attributes, listeners }) => (
                                  <div
                                    ref={setNodeRef}
                                    style={style}
                                    className="wt-row-wrap"
                                    {...attributes}
                                    {...listeners}
                                  >
                                    <div
                                      className="tree-row tree-row--worktree draft-row"
                                      data-active={location.pathname === `/draft/${s.id}`}
                                      style={{ position: "relative" }}
                                      title={s.name?.trim() || draftLabel(s.draftPrompt)}
                                    >
                                      <Link
                                        to={`/draft/${s.id}`}
                                        className="wt-row__stretch-link"
                                        draggable={false}
                                        tabIndex={-1}
                                        onClick={() => { if (isMobile) setMobileSidebarOpen(false); }}
                                      />
                                      <div className="wt-row__expand">
                                        <span className="wt-leading-slot">
                                          <Bot size={10} aria-hidden />
                                        </span>
                                        <span className="wt-row__label draft-row__label">{s.name?.trim() || draftLabel(s.draftPrompt)}</span>
                                      </div>
                                      <div className="wt-row__trail draft-row__trail">
                                        <span className="draft-chip">Draft</span>
                                        <button
                                          type="button"
                                          className="draft-row__discard icon-btn tree-row__action"
                                          onPointerDown={(e) => e.stopPropagation()}
                                          onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setPendingDiscardDraft({ kind: "session", session: s });
                                          }}
                                          title="Discard draft"
                                        >
                                          ×
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </SortableRow>
                            );
                          }
                          const w = item.data;
                          const label = worktreeLabel(w);
                          return (
                            <SortableRow key={w.id} id={w.id}>
                              {({ setNodeRef, style, attributes, listeners }) => (
                                <div
                                  ref={setNodeRef}
                                  style={style}
                                  className="wt-row-wrap"
                                  {...attributes}
                                >
                                  <div
                                    className="tree-row tree-row--worktree"
                                    data-active={activeWorktreeId === w.id && location.pathname.startsWith("/worktree/")}
                                    style={{ position: "relative" }}
                                    title={collapsed ? `${label} — select worktree` : undefined}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        void selectWorktree(p.id, w);
                                      }
                                    }}
                                    onClickCapture={suppressDoubleClickNavigation}
                                    onDoubleClick={(e) => {
                                      if (collapsed) return;
                                      e.preventDefault();
                                      e.stopPropagation();
                                      startInlineRename("worktree", w.id, label, "tree");
                                    }}
                                    {...listeners}
                                  >
                                    <Link
                                      to={`/worktree/${w.id}`}
                                      className="wt-row__stretch-link"
                                      draggable={false}
                                      aria-label={`Open worktree ${label}`}
                                      onClick={(e) => {
                                        if (isModifiedClick(e)) return;
                                        if (isWorktreeActive(w.id)) e.preventDefault();
                                        selectWorktree(p.id, w);
                                      }}
                                      tabIndex={-1}
                                    />
                                    <div className="wt-row__expand">
                                      {!collapsed ? (
                                        <span className="wt-leading-slot">
                                          <StatusDot
                                            status={worktreeRolledUpStatus(sessionMap[w.id] ?? [], sessionStates)}
                                            pr={worktreePrStatus(sessionMap[w.id] ?? [], w.branch)}
                                          />
                                        </span>
                                      ) : null}
                                      {!collapsed &&
                                      inlineRename?.kind === "worktree" &&
                                      inlineRename.id === w.id &&
                                      inlineRename.site === "tree" ? (
                                        <input
                                          ref={inlineInputRef}
                                          className="wt-row__label wt-row__rename-input"
                                          aria-label="Rename"
                                          value={inlineValue}
                                          autoFocus
                                          onClick={(e) => e.stopPropagation()}
                                          onPointerDown={(e) => e.stopPropagation()}
                                          onChange={(e) => setInlineValue(e.target.value)}
                                          onBlur={commitInlineRename}
                                          onKeyDown={(e) => {
                                            e.stopPropagation();
                                            if (e.key === "Enter") { e.preventDefault(); commitInlineRename(); }
                                            if (e.key === "Escape") { e.preventDefault(); setInlineRename(null); }
                                          }}
                                          maxLength={60}
                                        />
                                      ) : (
                                        <span className="wt-row__label">
                                          {collapsed
                                            ? disambiguatedAbbrev(
                                                label,
                                                w.id,
                                                orderedWtList.map((x) => ({ id: x.id, name: worktreeLabel(x) })),
                                              )
                                            : label}
                                        </span>
                                      )}
                                    </div>
                                    {!collapsed ? (
                                      <div className="wt-row__trail" style={{ position: "relative", zIndex: 2 }}>
                                        <DiffStatBadge stat={diffStats[w.id] ?? null} />
                                        <span className="wt-row__id" title={w.id}>
                                          {w.id}
                                        </span>
                                        <button
                                          type="button"
                                          data-wt-menu-trigger
                                          className="icon-btn wt-menu-trigger tree-row__action"
                                          aria-label={`Worktree actions for ${label}`}
                                          aria-expanded={wtMenu?.worktree.id === w.id}
                                          aria-haspopup="menu"
                                          title="Worktree menu"
                                          onPointerDown={(e) => e.stopPropagation()}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            const rect = e.currentTarget.getBoundingClientRect();
                                            setWtMenu((prev) =>
                                              prev?.worktree.id === w.id
                                                ? null
                                                : { projectId: p.id, worktree: w, rect },
                                            );
                                          }}
                                        >
                                          <MoreHorizontal size={16} />
                                        </button>
                                      </div>
                                    ) : null}
                                  </div>
                                  {/* Worktree agents inside this worktree */}
                                  {openWorktrees.has(w.id) || (trimmedQuery.length > 0)
                                    ? (() => {
                                        const wtAgents = (sessionMap[w.id] ?? []).filter((s) => {
                                          if (s.type !== "agent") return false;
                                          if (!trimmedQuery || matchText(worktreeLabel(w)) || matchText(w.branch) || projectDirectlyMatches(p)) return true;
                                          return sessionMatchesQuery(s);
                                        });
                                        if (wtAgents.length === 0) return null;
                                        return (
                                          <div className="worktree-sessions-wrapper">
                                            {!collapsed ? (
                                              <div
                                                className="tree-row tree-row--group-header tree-row--worktree-agents-header"
                                                role="button"
                                                tabIndex={0}
                                                onClick={() => {
                                                  setOpenWorktrees((prev) => {
                                                    const next = new Set(prev);
                                                    if (next.has(w.id)) next.delete(w.id);
                                                    else next.add(w.id);
                                                    return next;
                                                  });
                                                }}
                                                onKeyDown={(e) => {
                                                  if (e.key === "Enter" || e.key === " ") {
                                                    e.preventDefault();
                                                    setOpenWorktrees((prev) => {
                                                      const next = new Set(prev);
                                                      if (next.has(w.id)) next.delete(w.id);
                                                      else next.add(w.id);
                                                      return next;
                                                    });
                                                  }
                                                }}
                                              >
                                                <span className="tree-row__group-title">
                                                  {wtAgents.length} {wtAgents.length === 1 ? "agent" : "agents"}
                                                </span>
                                              </div>
                                            ) : null}
                                            <div className="worktree-sessions-group">
                                              {wtAgents
                                                .slice()
                                                .sort((a, b) => {
                                                  if (a.isMain && !b.isMain) return -1;
                                                  if (!a.isMain && b.isMain) return 1;
                                                  const ao = a.sortOrder ?? 0;
                                                  const bo = b.sortOrder ?? 0;
                                                  if (ao !== bo) return ao - bo;
                                                  return (a.createdAt || "").localeCompare(b.createdAt || "");
                                                })
                                                .map((sess) => {
                                                  const sLabel = sessionLabel(sess);
                                                  const isSessActive =
                                                    location.pathname.startsWith("/worktree") &&
                                                    activeWorktreeId === w.id &&
                                                    activeSessionId === sess.id;
                                                  return (
                                                    <div
                                                      key={sess.id}
                                                      className="tree-row tree-row--worktree-session"
                                                      data-active={isSessActive}
                                                      style={{ position: "relative" }}
                                                      title={collapsed ? `${sLabel} — worktree session` : undefined}
                                                      role="button"
                                                      tabIndex={0}
                                                      onKeyDown={(e) => {
                                                        if (e.key === "Enter" || e.key === " ") {
                                                          e.preventDefault();
                                                          selectWorktreeAgent(p.id, w, sess.id);
                                                        }
                                                      }}
                                                      onClickCapture={suppressDoubleClickNavigation}
                                                      onDoubleClick={(e) => {
                                                        if (collapsed) return;
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        startInlineRename("session", sess.id, sLabel, "tree");
                                                      }}
                                                    >
                                                      <Link
                                                        to={`/worktree/${w.id}/${sess.id}`}
                                                        className="wt-row__stretch-link"
                                                        draggable={false}
                                                        aria-label={`Open session ${sLabel}`}
                                                        onClick={(e) => {
                                                          if (isModifiedClick(e)) return;
                                                          if (isMobile) setMobileSidebarOpen(false);
                                                          selectWorktreeAgent(p.id, w, sess.id);
                                                        }}
                                                        tabIndex={-1}
                                                      />
                                                      <span className="direct-session__icon">
                                                        <StatusDot
                                                          status={sessionStateToStatus(sessionStates[sess.id] ?? sess.state)}
                                                          pr={null}
                                                        />
                                                      </span>
                                                      {!collapsed ? (
                                                        <SidebarSessionModeIcon session={sess} api={api} />
                                                      ) : null}
                                                      {!collapsed &&
                                                      inlineRename?.kind === "session" &&
                                                      inlineRename.id === sess.id &&
                                                      inlineRename.site === "tree" ? (
                                                        <input
                                                          ref={inlineInputRef}
                                                          className="direct-session__label direct-session__rename-input"
                                                          aria-label="Rename"
                                                          value={inlineValue}
                                                          autoFocus
                                                          onClick={(e) => e.stopPropagation()}
                                                          onPointerDown={(e) => e.stopPropagation()}
                                                          onChange={(e) => setInlineValue(e.target.value)}
                                                          onBlur={commitInlineRename}
                                                          onKeyDown={(e) => {
                                                            e.stopPropagation();
                                                            if (e.key === "Enter") { e.preventDefault(); commitInlineRename(); }
                                                            if (e.key === "Escape") { e.preventDefault(); setInlineRename(null); }
                                                          }}
                                                          maxLength={60}
                                                        />
                                                      ) : (
                                                        <span className="direct-session__label">
                                                          {collapsed ? sLabel.slice(0, 3) : sLabel}
                                                        </span>
                                                      )}
                                                      {!collapsed && sess.pinnedAt ? (
                                                        <Pin size={10} fill="currentColor" aria-label="Pinned" style={{ flexShrink: 0, opacity: 0.7 }} />
                                                      ) : null}
                                                      {!collapsed ? (
                                                        <div className="wt-row__trail" style={{ position: "relative", zIndex: 2 }}>
                                                          <button
                                                            type="button"
                                                            data-sess-menu-trigger
                                                            className="icon-btn wt-menu-trigger tree-row__action"
                                                            aria-label={`Session actions for ${sLabel}`}
                                                            aria-haspopup="menu"
                                                            aria-expanded={sessMenu?.session.id === sess.id}
                                                            title="Session menu"
                                                            onPointerDown={(e) => e.stopPropagation()}
                                                            onClick={(e) => {
                                                              e.preventDefault();
                                                              e.stopPropagation();
                                                              const rect = e.currentTarget.getBoundingClientRect();
                                                              setSessMenu((prev) =>
                                                                prev?.session.id === sess.id ? null : { session: sess, rect },
                                                              );
                                                            }}
                                                          >
                                                            <MoreHorizontal size={16} />
                                                          </button>
                                                        </div>
                                                      ) : null}
                                                    </div>
                                                  );
                                                })}
                                            </div>
                                          </div>
                                        );
                                      })()
                                    : null}
                                </div>
                              )}
                            </SortableRow>
                          );
                        })}
                      </SortableContext>
                    </DndContext>
                  );
                })()
              : null}
          </div>
          )}
          </SortableRow>
          );
        })}
        </SortableContext>
        </DndContext>
        )}
      </div>
      {!collapsed ? (
        <div className="left-sidebar__footer">
          <div className="left-sidebar__icon-row">
            <ThemeQuickPicker />
            <button
              type="button"
              className="icon-btn"
              aria-label="Toggle font"
              title="Font"
              onClick={toggleFont}
            >
              <Type size={14} />
            </button>
          </div>
          <div className="left-sidebar__icon-row left-sidebar__icon-row--end">
            <button
              type="button"
              className="icon-btn"
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts"
              onClick={onOpenShortcuts}
            >
              <Keyboard size={14} />
            </button>
            <button
              type="button"
              className="icon-btn left-sidebar__doctor-btn"
              aria-label={
                doctorStatus.fetchState === "unreachable"
                  ? "Doctor — can't reach daemon"
                  : !doctorStatus.report
                    ? "Doctor — checking"
                    : doctorStatus.report.ok
                    ? "Doctor — all checks passing"
                    : doctorStatus.report.hardOk
                      ? "Doctor — some checks need attention"
                      : "Doctor — required checks failing"
              }
              title="Doctor"
              onClick={() => navigate("/settings/doctor")}
              style={{ position: "relative" }}
            >
              <Stethoscope size={14} />
              {doctorStatus.fetchState === "unreachable" ? (
                <span className="left-sidebar__doctor-dot left-sidebar__doctor-dot--grey" aria-hidden="true" />
              ) : doctorStatus.report && !doctorStatus.report.hardOk ? (
                <span className="left-sidebar__doctor-dot left-sidebar__doctor-dot--red" aria-hidden="true" />
              ) : doctorStatus.report && (doctorStatus.report.featureOk === false || !doctorStatus.report.ok) ? (
                <span className="left-sidebar__doctor-dot left-sidebar__doctor-dot--yellow" aria-hidden="true" />
              ) : null}
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Settings"
              title="Settings"
              onClick={() => navigate("/settings")}
            >
              <Settings size={14} />
            </button>
          </div>
        </div>
      ) : null}

      {/* Plus menu for project actions */}
      {plusMenu ? (
        <ProjectPlusMenu
          project={plusMenu.project}
          rect={plusMenu.rect}
          onNewWorktree={() => {
            const project = plusMenu.project;
            setPlusMenu(null);
            handleNewWorktree(project);
          }}
          onDirectAgent={() => {
            const project = plusMenu.project;
            setPlusMenu(null);
            handleNewDirectAgent(project);
          }}
          onClose={() => setPlusMenu(null)}
        />
      ) : null}

      <HiddenWorktreesDialog
        open={hiddenWtDialogProjectId !== null}
        worktrees={hiddenWtDialogProjectId ? (hiddenWorktreeMap[hiddenWtDialogProjectId] ?? []) : []}
        api={api}
        onClose={() => setHiddenWtDialogProjectId(null)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete worktree?"
        message={
          pendingDelete
            ? `Remove “${pendingDelete.branch}” from this workspace? Sessions attached to this worktree will be removed from the UI.`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={() => void confirmDeleteWorktree()}
        onCancel={() => setPendingDelete(null)}
      />


      <ConfirmDialog
        open={pendingTerminateSession !== null}
        title="Terminate agent?"
        message={
          pendingTerminateSession
            ? `Terminate “${sessionLabel(pendingTerminateSession)}”? The agent process is stopped. Your project files are NOT touched.`
            : ""
        }
        confirmLabel="Terminate"
        onConfirm={() => void confirmTerminateSession()}
        onCancel={() => setPendingTerminateSession(null)}
      />

      <ConfirmDialog
        open={pendingDiscardDraft !== null}
        title="Discard draft?"
        message={
          pendingDiscardDraft
            ? pendingDiscardDraft.kind === "global"
              ? globalDraft?.draftPrompt?.trim()
                ? `Discard draft “${draftLabel(globalDraft.draftPrompt)}”? The draft prompt and settings will be removed.`
                : "Discard this draft? The draft prompt and settings will be removed."
              : pendingDiscardDraft.session.name?.trim() || pendingDiscardDraft.session.draftPrompt?.trim()
                ? `Discard draft “${pendingDiscardDraft.session.name?.trim() || draftLabel(pendingDiscardDraft.session.draftPrompt)}”? The draft prompt and settings will be removed.`
                : "Discard this draft? The draft prompt and settings will be removed."
            : ""
        }
        confirmLabel="Discard"
        onConfirm={handleConfirmDiscardDraft}
        onCancel={() => setPendingDiscardDraft(null)}
      />

      <ConfirmDialog
        open={pendingDeleteWorkspace !== null}
        title="Delete workspace?"
        message={
          pendingDeleteWorkspace
            ? `Remove the saved workspace “${pendingDeleteWorkspace.name}”? This can't be undone.`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={confirmDeleteWorkspace}
        onCancel={() => setPendingDeleteWorkspace(null)}
      />

      {wtMenu
        ? (() => {
            const popupWidth = 160;
            const popupHeight = 165;
            const { top, left } = clampPopupPosition(
              wtMenu.rect,
              popupWidth,
              popupHeight,
              envWidth,
              envHeight,
            );
            return createPortal(
              <div
                ref={(node) => {
                  if (!node) return;
                  const rect = node.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    const adjusted = clampPopupPosition(
                      wtMenu.rect,
                      rect.width,
                      rect.height,
                      envWidth,
                      envHeight,
                    );
                    node.style.top = `${adjusted.top}px`;
                    node.style.left = `${adjusted.left}px`;
                  }
                }}
                className="menu-pop wt-menu-pop--portal"
                data-wt-menu-panel
                role="menu"
                aria-label="Worktree actions"
                style={{
                  position: "fixed",
                  top,
                  left,
                  minWidth: 140,
                  maxHeight: Math.max(80, envHeight - 16),
                  overflowY: "auto",
                  zIndex: 4000,
                }}
              >
                <div className="wt-menu__info-row">
                  <span className="wt-menu__info-label">ID</span>
                  <span className="wt-menu__info-value">{wtMenu.worktree.id}</span>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-pop__item menu-pop__item--icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    const wtId = wtMenu.worktree.id;
                    const wasPinned = wtMenu.worktree.pinnedAt != null;
                    setWtMenu(null);
                    void (async () => {
                      try {
                        if (wasPinned) await api.unpinWorktree(wtId);
                        else await api.pinWorktree(wtId);
                        // Store stays current via the `worktree:updated` WS event.
                      } catch {
                        /* surface errors later */
                      }
                    })();
                  }}
                >
                  <Pin
                    size={13}
                    aria-hidden
                    fill={wtMenu.worktree.pinnedAt != null ? "currentColor" : "none"}
                  />
                  {wtMenu.worktree.pinnedAt != null ? "Unpin" : "Pin to top"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-pop__item menu-pop__item--icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    const wtId = wtMenu.worktree.id;
                    setWtMenu(null);
                    void (async () => {
                      try {
                        await api.hideWorktree(wtId);
                        // Store stays current via the `worktree:updated` WS event.
                      } catch {
                        /* surface errors later */
                      }
                    })();
                  }}
                >
                  <EyeOff size={13} aria-hidden />
                  Hide
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-pop__item"
                  onClick={(e) => {
                    e.stopPropagation();
                    void (async () => {
                      try {
                        await api.markWorktreeDone(wtMenu.worktree.id);
                        // Store stays current via per-session `session:state`
                        // events emitted by the daemon when marking done.
                      } catch {
                        /* surface errors later */
                      }
                      setWtMenu(null);
                    })();
                  }}
                >
                  Mark as done
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-pop__item--danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDelete(wtMenu.worktree);
                    setWtMenu(null);
                  }}
                >
                  Delete worktree…
                </button>
              </div>,
              portalRoot,
            );
          })()
        : null}
      {sessMenu
        ? (() => {
            const popupWidth = 160;
            const popupHeight = sessMenu.session.type === "agent" ? 120 : 85;
            const { top, left } = clampPopupPosition(
              sessMenu.rect,
              popupWidth,
              popupHeight,
              envWidth,
              envHeight,
            );
            return createPortal(
              <div
                ref={(node) => {
                  if (!node) return;
                  const rect = node.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    const adjusted = clampPopupPosition(
                      sessMenu.rect,
                      rect.width,
                      rect.height,
                      envWidth,
                      envHeight,
                    );
                    node.style.top = `${adjusted.top}px`;
                    node.style.left = `${adjusted.left}px`;
                  }
                }}
                className="menu-pop wt-menu-pop--portal"
                data-sess-menu-panel
                role="menu"
                aria-label="Session actions"
                style={{
                  position: "fixed",
                  top,
                  left,
                  minWidth: 150,
                  maxHeight: Math.max(80, envHeight - 16),
                  overflowY: "auto",
                  zIndex: 4000,
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="menu-pop__item menu-pop__item--icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    const sid = sessMenu.session.id;
                    const wasPinned = sessMenu.session.pinnedAt != null;
                    setSessMenu(null);
                    void (async () => {
                      try {
                        await api.pinSession(sid, !wasPinned);
                        // Store stays current via the `session:updated` WS event.
                      } catch {
                        /* surface errors later */
                      }
                    })();
                  }}
                >
                  <Pin
                    size={13}
                    aria-hidden
                    fill={sessMenu.session.pinnedAt != null ? "currentColor" : "none"}
                  />
                  {sessMenu.session.pinnedAt != null ? "Unpin" : "Pin to top"}
                </button>
                {sessMenu.session.type === "agent" ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-pop__item"
                    onClick={(e) => {
                      e.stopPropagation();
                      const sid = sessMenu.session.id;
                      setSessMenu(null);
                      void (async () => {
                        try {
                          await api.markSessionDone(sid);
                          // Store stays current via the `session:state` WS event.
                        } catch {
                          /* surface errors later */
                        }
                      })();
                    }}
                  >
                    Mark as done
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="menu-pop__item"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingTerminateSession(sessMenu.session);
                    setSessMenu(null);
                  }}
                >
                  Terminate
                </button>
              </div>,
              portalRoot,
            );
          })()
        : null}
      {projMenu
        ? (() => {
            const hiddenCount = hiddenWorktreeMap[projMenu.project.id]?.length ?? 0;
            const popupWidth = 160;
            const popupHeight = hiddenCount > 0 ? 80 : 45;
            const { top, left } = clampPopupPosition(
              projMenu.rect,
              popupWidth,
              popupHeight,
              envWidth,
              envHeight,
            );
            return createPortal(
              <div
                ref={(node) => {
                  if (!node) return;
                  const rect = node.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    const adjusted = clampPopupPosition(
                      projMenu.rect,
                      rect.width,
                      rect.height,
                      envWidth,
                      envHeight,
                    );
                    node.style.top = `${adjusted.top}px`;
                    node.style.left = `${adjusted.left}px`;
                  }
                }}
                className="menu-pop wt-menu-pop--portal"
                data-proj-menu-panel
                role="menu"
                aria-label="Project actions"
                style={{
                  position: "fixed",
                  top,
                  left,
                  minWidth: 160,
                  maxHeight: Math.max(80, envHeight - 16),
                  overflowY: "auto",
                  zIndex: 4000,
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="menu-pop__item menu-pop__item--icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    const project = projMenu.project;
                    const rect = projMenu.rect;
                    setProjMenu(null);
                    setPendingHideProject({ project, rect });
                  }}
                >
                  <EyeOff size={13} aria-hidden />
                  Hide project
                </button>
                {(() => {
                  if (hiddenCount === 0) return null;
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-pop__item menu-pop__item--icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        setHiddenWtDialogProjectId(projMenu.project.id);
                        setProjMenu(null);
                      }}
                    >
                      <Eye size={13} aria-hidden />
                      {`Hidden worktrees (${hiddenCount})`}
                    </button>
                  );
                })()}
              </div>,
              portalRoot,
            );
          })()
        : null}
      {pendingHideProject
        ? (() => {
            const popupWidth = 240;
            const popupHeight = 135;
            const { top, left } = clampPopupPosition(
              pendingHideProject.rect,
              popupWidth,
              popupHeight,
              envWidth,
              envHeight,
            );

            return createPortal(
              <div
                ref={(node) => {
                  if (!node) return;
                  const rect = node.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    const adjusted = clampPopupPosition(
                      pendingHideProject.rect,
                      rect.width,
                      rect.height,
                      envWidth,
                      envHeight,
                    );
                    node.style.top = `${adjusted.top}px`;
                    node.style.left = `${adjusted.left}px`;
                  }
                }}
                className="menu-pop"
                data-hide-project-popup
                role="dialog"
                aria-modal="true"
                aria-label="Hide project?"
                style={{
                  position: "fixed",
                  top,
                  left,
                  width: popupWidth,
                  maxHeight: Math.max(80, envHeight - 16),
                  overflowY: "auto",
                  padding: "var(--space-3)",
                  zIndex: 4000,
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                  boxShadow: "var(--shadow-lg, var(--shadow-md))",
                }}
              >
                <div
                  style={{
                    fontSize: "var(--font-size-sm)",
                    fontWeight: "var(--font-weight-medium)",
                    color: "var(--fg-primary)",
                  }}
                >
                  Hide project?
                </div>
                <div
                  style={{
                    fontSize: "var(--font-size-xs)",
                    color: "var(--fg-secondary)",
                    lineHeight: 1.4,
                  }}
                >
                  {`Hide “${pendingHideProject.project.name}”? Hidden projects can be managed in settings later.`}
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "var(--space-2)",
                    marginTop: "var(--space-1)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setPendingHideProject(null)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "var(--space-1) var(--space-2-5, 10px)",
                      fontSize: "var(--font-size-xs)",
                      borderRadius: "var(--radius-md)",
                      border: "var(--border-width) solid var(--border-default)",
                      background: "transparent",
                      color: "var(--fg-primary)",
                      cursor: "pointer",
                      width: "auto",
                      textAlign: "center",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirmHideProject()}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "var(--space-1) var(--space-2-5, 10px)",
                      fontSize: "var(--font-size-xs)",
                      borderRadius: "var(--radius-md)",
                      border: "var(--border-width) solid var(--destructive)",
                      background: "transparent",
                      color: "var(--destructive)",
                      cursor: "pointer",
                      width: "auto",
                      textAlign: "center",
                    }}
                  >
                    Hide
                  </button>
                </div>
              </div>,
              portalRoot,
            );
          })()
        : null}
      {filterMenuRect
        ? (() => {
            const popupWidth = 140;
            const popupHeight = 45;
            const { top, left } = clampPopupPosition(
              filterMenuRect,
              popupWidth,
              popupHeight,
              envWidth,
              envHeight,
            );
            return createPortal(
              <div
                ref={(node) => {
                  if (!node) return;
                  const rect = node.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    const adjusted = clampPopupPosition(
                      filterMenuRect,
                      rect.width,
                      rect.height,
                      envWidth,
                      envHeight,
                    );
                    node.style.top = `${adjusted.top}px`;
                    node.style.left = `${adjusted.left}px`;
                  }
                }}
                className="menu-pop wt-menu-pop--portal"
                data-filter-menu-panel
                role="menu"
                aria-label="Filter options"
                style={{
                  position: "fixed",
                  top,
                  left,
                  minWidth: 140,
                  maxHeight: Math.max(80, envHeight - 16),
                  overflowY: "auto",
                  zIndex: 4000,
                }}
              >
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={hideInactiveWorktrees}
                  className={`menu-pop__item menu-pop__item--check${hideInactiveWorktrees ? " menu-pop__item--active" : ""}`}
                  onClick={() => { toggleInactiveWorktreesFilter(); setFilterMenuRect(null); }}
                >
                  <span className="menu-pop__check" aria-hidden>
                    {hideInactiveWorktrees ? <Check size={13} strokeWidth={2.5} /> : null}
                  </span>
                  Hide done
                </button>
              </div>,
              portalRoot,
            );
          })()
        : null}
    </div>
  );
}
