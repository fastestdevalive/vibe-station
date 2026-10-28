import { ChevronDown, ChevronRight, PackageOpen, Pin } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ApiInstance } from "@/api";
import type { ArtifactRow as Row, ArtifactScopeKind } from "@/api/types";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import { Toast } from "@/components/ui/Toast";
import { useIsTouch } from "@/hooks/useIsTouch";
import { useLongPress } from "@/hooks/useLongPress";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useRovingListNav } from "@/hooks/useRovingListNav";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { copyText } from "@/lib/copyText";
import { sessionLabel } from "@/lib/sessionLabel";
import { ModeHeaderActionsHost } from "@/components/layout/TopActionsSlot";
import { ArtifactMenu, type MenuAnchor } from "./ArtifactMenu";
import { ArtifactRow } from "./ArtifactRow";
import {
  artifactCount,
  filterSessions,
  groupOf,
  matchesSession,
  scopeSessions,
  writerLabel,
  type ArtifactGroupId,
} from "./artifactSessions";
import { removeArtifactRow, toggleArtifactPin } from "./artifactActions";
import { ARTIFACT_CAP_DEFAULT, NO_ROWS, rowMatchesPath, useArtifactsStore } from "./artifactsStore";
import { fetchArtifactScope, useArtifactScope } from "./useArtifactsSync";
import "./artifacts.css";

type ListApi = Pick<ApiInstance, "listArtifacts" | "pinArtifact" | "removeArtifact">;

export interface ArtifactsListProps {
  api: ListApi;
  /** Resolved context id: worktree id, or the project id for a direct session. */
  worktreeId: string;
  scope: ArtifactScopeKind;
  /** Path of the active file tab; the matching row renders selected. */
  selectedPath?: string | null;
  /** Row activated (click / Enter). */
  onOpen?: (row: Row) => void;
  /** Fetch the list only while true (the tools panel stays mounted offscreen: fetch on first need, not on mount). */
  enabled?: boolean;
}

const SEG_MAX = 3;
const SKELETON_WIDTHS = [35, 85, 60, 90, 50];
const GROUP_LABEL: Record<ArtifactGroupId, string> = { pinned: "Pinned", run: "This run", earlier: "Earlier" };

type LocalNotice = { seq: number; text: string };

/** The Artifacts list-panel body (`Main.dc.html` board 1, `ArtifactStates.dc.html`, `Mobile.dc.html`). */
export function ArtifactsList({ api, worktreeId: scopeId, scope, selectedPath = null, onOpen, enabled = true }: ArtifactsListProps) {
  useArtifactScope(api, scope, enabled ? scopeId : null);
  const entry = useArtifactsStore((s) => s.byScope[scopeId]);
  const sessions = useServerStore((s) => s.sessions);
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);
  const mobile = useIsMobile();
  const touch = useIsTouch();

  const rows = entry?.rows ?? NO_ROWS;
  const status = entry?.status ?? "idle";

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const options = useMemo(() => filterSessions(scopeSessions(sessions, scope, scopeId)), [sessions, scope, scopeId]);

  const [filter, setFilter] = useState<string>("all");
  const activeFilter = filter !== "all" && options.some((s) => s.id === filter) ? filter : "all";

  const visible = useMemo(
    () => (activeFilter === "all" ? rows : rows.filter((r) => matchesSession(r, activeFilter, byId))),
    [rows, activeFilter, byId],
  );

  const groups = useMemo(() => {
    const g: Record<ArtifactGroupId, Row[]> = { pinned: [], run: [], earlier: [] };
    for (const r of visible) g[groupOf(r, byId, sessionStates)].push(r);
    return g;
  }, [visible, byId, sessionStates]);

  // Collapse state lives in the store (survives a worktree switch): This run expanded, Earlier collapsed by default.
  const groupOpen = useArtifactsStore((s) => s.groupOpen[scopeId]);
  const isOpen = useCallback(
    (g: ArtifactGroupId) => g === "pinned" || (groupOpen?.[g] ?? g === "run"),
    [groupOpen],
  );
  const toggleGroup = (g: "run" | "earlier") => useArtifactsStore.getState().setGroupOpen(scopeId, g, !isOpen(g));

  const navRows = useMemo(
    () => (["pinned", "run", "earlier"] as const).flatMap((g) => (isOpen(g) ? groups[g] : [])).map((r) => ({ path: r.id })),
    [groups, isOpen],
  );

  const [menu, setMenu] = useState<{ row: Row; anchor: MenuAnchor } | null>(null);
  const [local, setLocal] = useState<LocalNotice | null>(null);
  const noticeSeq = useRef(0);
  const closeMenu = useCallback(() => setMenu(null), []);
  const paneRef = useRef<HTMLDivElement>(null);

  // The portaled menu must never outlive a hidden list (pane display:none,
  // collapsed, or mode switched).
  const menuOpen = menu != null;
  useEffect(() => {
    const el = paneRef.current;
    if (!menuOpen || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last && !last.isIntersecting) closeMenu();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [menuOpen, closeMenu]);
  const notify = (text: string) => setLocal({ seq: ++noticeSeq.current, text });

  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const openRow = useCallback((row: Row) => onOpenRef.current?.(row), []);
  const { cursorPath, setCursorPath, handleKeyDown, isTabbable } = useRovingListNav(navRows, {
    onOpen: (id) => {
      const row = rows.find((r) => r.id === id);
      if (row) openRow(row);
    },
  });

  const focusRow = useCallback((row: Row) => setCursorPath(row.id), [setCursorPath]);

  const rowRefs = useRef(new Map<string, HTMLElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const setRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);

  // Arrow keys move the cursor; focus follows only while focus is already inside the list.
  useEffect(() => {
    if (!cursorPath) return;
    const el = rowRefs.current.get(cursorPath);
    if (el && listRef.current?.contains(document.activeElement) && document.activeElement !== el) el.focus();
  }, [cursorPath]);

  // A pin moves the row to another group (a remount): keyboard pins put focus back on the row afterwards.
  const refocusId = useRef<string | null>(null);
  useEffect(() => {
    const id = refocusId.current;
    if (!id) return;
    const el = rowRefs.current.get(id);
    if (el) {
      refocusId.current = null;
      el.focus();
    }
  }, [rows]);

  const togglePin = async (row: Row): Promise<boolean> => {
    const note = await toggleArtifactPin(api, scopeId, row);
    if (note) notify(note);
    return note === null;
  };
  const removeRow = async (row: Row) => {
    if ((await removeArtifactRow(api, scopeId, row)) === "failed") notify("Couldn’t remove this artifact");
  };
  const copyPath = (row: Row) => {
    void copyText(row.path);
  };

  const openMenu = useCallback((row: Row, anchor: MenuAnchor) => setMenu({ row, anchor }), []);

  const longPress = useLongPress({
    enabled: touch || mobile,
    onLongPress: (target, point) => {
      const id = target.closest<HTMLElement>("[data-artifact-id]")?.dataset.artifactId;
      const row = id ? rows.find((r) => r.id === id) : undefined;
      if (!row) return false;
      openMenu(row, { x: point.x, y: point.y });
      return true;
    },
  });

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // The menu is portaled: its key events still bubble here through React, so only handle our own DOM.
    if (!(e.target instanceof HTMLElement) || !e.currentTarget.contains(e.target)) return;
    const optionEl = e.target.closest<HTMLElement>('[role="option"]');
    if (!optionEl) return;
    const row = rows.find((r) => r.id === optionEl.dataset.artifactId);
    if (!row || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "p" && !e.shiftKey) {
      e.preventDefault();
      refocusId.current = row.id;
      void togglePin(row).then((ok) => {
        if (!ok) refocusId.current = null;
      });
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      openMenu(row, { el: optionEl });
    } else {
      handleKeyDown(e);
    }
  };

  const filterLabel = (id: string) => sessionLabel(byId.get(id)!);

  // Segmented only while it fits: when it overflows the row, fall back to the dropdown until the row is wide enough again.
  const toolsRef = useRef<HTMLDivElement>(null);
  const segRef = useRef<HTMLDivElement>(null);
  const metaRef = useRef<HTMLSpanElement>(null);
  const optionKey = options.map((s) => s.id).join("|");
  // The needed width is tied to the option set it was measured for; a different set starts over.
  const [seg, setSeg] = useState<{ key: string; needed: number } | null>(null);
  const segNeeded = seg && seg.key === optionKey ? seg.needed : null;
  const setSegNeeded = useCallback((needed: number | null) => setSeg(needed == null ? null : { key: optionKey, needed }), [optionKey]);
  const showSeg = options.length > 0 && options.length <= SEG_MAX && segNeeded == null;
  const toolsShown = status === "ready" && rows.length > 0;
  useLayoutEffect(() => {
    const row = toolsRef.current;
    if (!toolsShown || !row || options.length === 0 || options.length > SEG_MAX) return;
    const measure = () => {
      const seg = segRef.current;
      if (seg) {
        if (seg.scrollWidth > seg.clientWidth) setSegNeeded(seg.scrollWidth);
        return;
      }
      if (segNeeded == null) return;
      const cs = getComputedStyle(row);
      const gap = parseFloat(cs.columnGap) || 0;
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const free = row.clientWidth - (metaRef.current?.offsetWidth ?? 0) - gap - pad;
      if (free >= segNeeded) setSegNeeded(null);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [toolsShown, options.length, segNeeded, setSegNeeded]);

  const filterUi =
    options.length === 0 ? null : showSeg ? (
      <div ref={segRef} className="artifacts-tools__seg">
        <SegmentedControl
          value={activeFilter}
          onChange={setFilter}
          options={[{ value: "all", label: "All sessions" }, ...options.map((s) => ({ value: s.id, label: filterLabel(s.id) }))]}
        />
      </div>
    ) : (
      <Select
        aria-label="Filter by session"
        className="artifacts-tools__select"
        style={{ width: "auto", maxWidth: "100%", padding: "0 8px", fontSize: "var(--fs-meta)" }}
        value={activeFilter}
        onChange={(e) => setFilter(e.target.value)}
      >
        <option value="all">Session: All ({options.length})</option>
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            Session: {filterLabel(s.id)}
          </option>
        ))}
      </Select>
    );

  const capNotice = entry?.capNotice;
  const addedNotice = entry?.addedNotice;
  const hasNotice = local != null || capNotice != null || addedNotice != null;
  const notices = (
    <>
      {local && (
        <Toast key={`l${local.seq}`} autoDismissMs={10_000} onDismiss={() => setLocal(null)}>
          {local.text}
        </Toast>
      )}
      {capNotice && (
        <Toast
          key={`c${capNotice.seq}`}
          autoDismissMs={10_000}
          onDismiss={() => useArtifactsStore.getState().dismissNotice(scopeId, "cap", capNotice.seq)}
        >
          {capNotice.count} oldest {capNotice.count === 1 ? "artifact was" : "artifacts were"} dropped (limit {entry?.cap}). Pinned are kept.
        </Toast>
      )}
      {addedNotice && (
        <AddedNotice
          key={`a${addedNotice.seq}`}
          row={addedNotice.row}
          writer={writerLabel(addedNotice.row, byId) ?? "An agent"}
          onRemove={() => {
            void removeRow(addedNotice.row);
            useArtifactsStore.getState().dismissNotice(scopeId, "added", addedNotice.seq);
          }}
          onDismiss={() => useArtifactsStore.getState().dismissNotice(scopeId, "added", addedNotice.seq)}
        />
      )}
    </>
  );

  let body;
  if (status === "error") {
    body = (
      <EmptyState
        className="artifacts-error"
        title="Couldn’t load artifacts"
        actions={
          <Button size="sm" onClick={() => void fetchArtifactScope(api, scope, scopeId)}>
            Retry
          </Button>
        }
      >
        The daemon didn’t answer. Showing nothing rather than a stale list.
      </EmptyState>
    );
  } else if (status !== "ready") {
    body = (
      <div className="artifacts-skeleton" data-testid="artifacts-skeleton">
        {SKELETON_WIDTHS.map((w, i) => (
          <div key={i} className="artifacts-skeleton__bar" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        icon={<PackageOpen size={28} aria-hidden="true" />}
        title="No artifacts yet"
        meta={
          <>
            Terminal agent? Run <code className="artifacts-code">vst artifact add &lt;path&gt;</code>
          </>
        }
      >
        Plans, docs and images an agent writes show up here from now on.
      </EmptyState>
    );
  } else if (visible.length === 0) {
    body = <div className="artifacts-nomatch">No artifacts from this session.</div>;
  } else {
    body = (
      <div ref={listRef} role="listbox" aria-label="Artifacts" className={`artifacts-listbox${mobile ? " artifacts-listbox--mobile" : ""}`} onKeyDown={onKeyDown} {...longPress}>
        {(["pinned", "run", "earlier"] as const).map((g) => {
          const list = groups[g];
          if (list.length === 0) return null;
          const expanded = isOpen(g);
          const headId = `artifacts-grp-${scopeId}-${g}`;
          return (
            <div key={g} role="group" aria-labelledby={headId} className="artifacts-group">
              {g === "pinned" ? (
                <div id={headId} className="artifacts-group__head artifacts-cap" aria-label={`Pinned, ${artifactCount(list.length)}`}>
                  <Pin size={12} aria-hidden="true" className="artifacts-group__pin" />
                  Pinned
                </div>
              ) : (
                <button
                  id={headId}
                  type="button"
                  className="artifacts-group__head artifacts-group__head--button artifacts-cap"
                  aria-expanded={expanded}
                  aria-label={`${GROUP_LABEL[g]}, ${artifactCount(list.length)}`}
                  onClick={() => toggleGroup(g)}
                >
                  {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                  {GROUP_LABEL[g]}
                  <span className="artifacts-group__count">· {list.length}</span>
                </button>
              )}
              {expanded &&
                list.map((r) => (
                  <ArtifactRow
                    key={r.id}
                    row={r}
                    writer={writerLabel(r, byId)}
                    selected={rowMatchesPath(r, selectedPath)}
                    tabbable={isTabbable(r.id)}
                    mobile={mobile}
                    menuOpen={menu?.row.id === r.id}
                    onOpen={openRow}
                    onFocusRow={focusRow}
                    onMenu={openMenu}
                    setRef={setRef}
                  />
                ))}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div ref={paneRef} className="artifacts-pane" aria-busy={status === "loading" || status === "idle"}>
      <div className="artifacts-head actions-row">
        <PackageOpen size={14} aria-hidden="true" className="artifacts-head__icon" />
        <span className="artifacts-head__title">Artifacts</span>
        {status === "ready" && (
          <Chip size="sm" aria-label={artifactCount(rows.length)}>
            {rows.length}
          </Chip>
        )}
        <ModeHeaderActionsHost mode="artifacts" />
      </div>
      <div className="artifacts-col">
        {status === "ready" && rows.length > 0 && (
          <div ref={toolsRef} className="artifacts-tools">
            {filterUi}
            <span ref={metaRef} className="artifacts-tools__meta">
              {entry?.total ?? rows.length} of {entry?.cap ?? ARTIFACT_CAP_DEFAULT}
            </span>
          </div>
        )}
        <div className="artifacts-list">{body}</div>
        {hasNotice && <div className="artifacts-notice">{notices}</div>}
      </div>
      {menu && (
        <ArtifactMenu
          row={menu.row}
          anchor={menu.anchor}
          mobile={mobile}
          onClose={closeMenu}
          onTogglePin={(r) => void togglePin(r)}
          onCopyPath={copyPath}
          onRemove={(r) => void removeRow(r)}
        />
      )}
    </div>
  );
}

function AddedNotice({ row, writer, onRemove, onDismiss }: { row: Row; writer: string; onRemove: () => void; onDismiss: () => void }) {
  return (
    <Toast onDismiss={onDismiss}>
      {writer} added {row.displayPath} (outside the repo) ·{" "}
      <button type="button" className="toast__action" onClick={onRemove}>
        Remove
      </button>
    </Toast>
  );
}
