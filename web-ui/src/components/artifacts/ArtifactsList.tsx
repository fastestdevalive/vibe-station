import { ChevronDown, ChevronRight, PackageOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ApiInstance } from "@/api";
import type { ArtifactRow as Row, ArtifactScopeKind } from "@/api/types";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import { useIsTouch } from "@/hooks/useIsTouch";
import { useLongPress } from "@/hooks/useLongPress";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useRovingListNav } from "@/hooks/useRovingListNav";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { copyText } from "@/lib/copyText";
import { useModesSync, type ModesApi } from "@/store/modesStore";
import { RailHeader } from "@/components/layout/RailHeader";
import { AgentFilterPicker } from "./AgentFilterPicker";
import { ArtifactMenu, type MenuAnchor } from "./ArtifactMenu";
import { ArtifactRow } from "./ArtifactRow";
import {
  artifactCount,
  filterSessions,
  groupOf,
  matchesSession,
  baseName,
  dirOf,
  scopeSessions,
  writerLabel,
  type ArtifactGroupId,
} from "./artifactSessions";
import { removeArtifactRow, toggleArtifactPin } from "./artifactActions";
import { useDetailsStore } from "@/components/details/detailsStore";
import { ARTIFACT_CAP_DEFAULT, NO_ROWS, rowMatchesPath, useArtifactsStore } from "./artifactsStore";
import { fetchArtifactScope, useArtifactScope } from "./useArtifactsSync";
import "./artifacts.css";

type ListApi = Pick<ApiInstance, "listArtifacts" | "pinArtifact" | "removeArtifact"> & ModesApi;

export interface ArtifactsListProps {
  api: ListApi;
  /** Resolved context id: worktree id, or the project id for a direct agent. */
  worktreeId: string;
  scope: ArtifactScopeKind;
  /** Path of the active file tab; the matching row renders selected. */
  selectedPath?: string | null;
  /** Row activated (click / Enter). */
  onOpen?: (row: Row) => void;
  /** Fetch the list only while true (the tools panel stays mounted offscreen: fetch on first need, not on mount). */
  enabled?: boolean;
}

const SKELETON_WIDTHS = [35, 85, 60, 90, 50];
const GROUP_LABEL: Record<ArtifactGroupId, string> = { pinned: "Pinned", run: "This run", earlier: "Earlier" };

type LocalNotice = { seq: number; text: string };

/** The Artifacts list-panel body (`Main.dc.html` board 1, `ArtifactStates.dc.html`, `Mobile.dc.html`). */
/**
 * Folder hints for same-named rows (tools-pane-rework B6): each row whose base name is shared gets the shortest run of
 * its own folders that no other same-named row shares (`web-ui` vs `rust/vst-git`). Unique names get none.
 */
export function folderHints(rows: Row[]): Map<string, string> {
  const byName = new Map<string, Row[]>();
  for (const r of rows) {
    const name = baseName(r.displayPath);
    byName.set(name, [...(byName.get(name) ?? []), r]);
  }
  const hints = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const folders = group.map((r) => dirOf(r.displayPath).split("/").filter(Boolean));
    group.forEach((r, i) => {
      const mine = folders[i]!;
      if (mine.length === 0) return;
      for (let depth = 1; depth <= mine.length; depth++) {
        const suffix = mine.slice(-depth).join("/");
        const shared = folders.some((f, j) => j !== i && f.slice(-depth).join("/") === suffix);
        if (!shared) {
          hints.set(r.id, suffix);
          return;
        }
      }
      hints.set(r.id, mine.join("/"));
    });
  }
  return hints;
}

/** The "n of cap" footer line shows once the list is within this many rows of its cap. */
const CAP_NEAR_MARGIN = 10;

export function ArtifactsList({ api, worktreeId: scopeId, scope, selectedPath = null, onOpen, enabled = true }: ArtifactsListProps) {
  useArtifactScope(api, scope, enabled ? scopeId : null);
  // Rows, picker options and their chips render mode icons without an api: the modes load once here, on first need.
  useModesSync(enabled ? api : undefined);
  const entry = useArtifactsStore((s) => s.byScope[scopeId]);
  const sessions = useServerStore((s) => s.sessions);
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);
  const mobile = useIsMobile();
  const touch = useIsTouch();

  const rows = entry?.rows ?? NO_ROWS;
  const hints = useMemo(() => folderHints(rows), [rows]);
  const status = entry?.status ?? "idle";

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const options = useMemo(() => filterSessions(scopeSessions(sessions, scope, scopeId)), [sessions, scope, scopeId]);

  const [filter, setFilter] = useState<string>("all");
  const activeFilter = filter !== "all" && options.some((s) => s.id === filter) ? filter : "all";
  // A vanished agent must not silently re-apply if it returns: drop the stored id once it leaves the options.
  useEffect(() => {
    if (filter !== "all" && activeFilter === "all") setFilter("all");
  }, [filter, activeFilter]);

  const filterOptions = useMemo(
    () => options.map((session) => ({ session, count: rows.filter((r) => matchesSession(r, session.id, byId)).length })),
    [options, rows, byId],
  );

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

  // The "n of cap" meta lives in the picker's menu; the footer line shows it once the list is near its cap.
  const filterUi =
    options.length === 0 ? null : (
      <AgentFilterPicker
        value={activeFilter}
        options={filterOptions}
        total={rows.length}
        sessionStates={sessionStates}
        mobile={mobile}
        onChange={setFilter}
        meta={`${entry?.total ?? rows.length} of ${entry?.cap ?? ARTIFACT_CAP_DEFAULT}`}
      />
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
    body = <div className="artifacts-nomatch">No artifacts from this agent.</div>;
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
                </button>
              )}
              {expanded &&
                list.map((r) => {
                  return (
                    <ArtifactRow
                      key={r.id}
                      row={r}
                      folderHint={hints.get(r.id)}
                      selected={rowMatchesPath(r, selectedPath)}
                      tabbable={isTabbable(r.id)}
                      mobile={mobile}
                      menuOpen={menu?.row.id === r.id}
                      onOpen={openRow}
                      onFocusRow={focusRow}
                      onMenu={openMenu}
                      setRef={setRef}
                    />
                  );
                })}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div ref={paneRef} className="artifacts-pane" aria-busy={status === "loading" || status === "idle"}>
      <RailHeader
        mode="artifacts"
        className="artifacts-head"
        left={
          <>
            <span className="artifacts-head__title">Artifacts</span>
            {status === "ready" ? (
              <span className="rail-header__count" aria-label={artifactCount(rows.length)}>
                {rows.length}
              </span>
            ) : null}
          </>
        }
        right={filterUi}
      />
      <div className="artifacts-col">
        <div className="artifacts-list">{body}</div>
        {status === "ready" && rows.length > 0 && rows.length >= (entry?.cap ?? ARTIFACT_CAP_DEFAULT) - CAP_NEAR_MARGIN ? (
          <div className="artifacts-foot">
            {entry?.total ?? rows.length} of {entry?.cap ?? ARTIFACT_CAP_DEFAULT}
          </div>
        ) : null}
        {hasNotice && <div className="artifacts-notice">{notices}</div>}
      </div>
      {menu && (
        <ArtifactMenu
          row={menu.row}
          anchor={menu.anchor}
          mobile={mobile}
          paneRef={paneRef}
          onClose={closeMenu}
          onTogglePin={(r) => void togglePin(r)}
          onCopyPath={copyPath}
          onDetails={(r) => useDetailsStore.getState().open({ scope, scopeId, path: r.path, name: baseName(r.displayPath), artifact: r })}
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
