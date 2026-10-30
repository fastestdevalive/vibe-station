import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, ListChecks } from "lucide-react";
import type { TaskSummary } from "@/api/types";
import { useRovingListNav } from "@/hooks/useRovingListNav";
import { TaskIcon } from "./TaskIcon";
import { useSecondTick } from "./useSecondTick";
import { useDelayedUnmount } from "./useDelayedUnmount";
import { useTrayMode } from "./useTrayMode";
import { classify, type View } from "./trayMode";
import { chipLabels, groupTasks, isQuiet, rowAriaLabel, rowMeta, summaryText, type TaskGroups } from "./taskFormat";

export interface TaskTrayProps {
  sessionId: string;
  groups: TaskGroups;
  total: number;
  /** False until the first snapshot of this connection arrived (reconnect resets it): keep showing last-known. */
  known: boolean;
  /** Preferred view while a task is active (persisted), not the live tray state. */
  pref: View;
  onPrefChange: (v: View) => void;
  /** The full-window task view is open; the footer is inert meanwhile. */
  taskViewOpen: boolean;
  onOpenTask: (id: string) => void;
  /** Esc collapses and hands focus back to the composer (same as QueuedTray). */
  focusComposer?: () => void;
}

const EMPTY = groupTasks([], 0);
const inertProps = (inactive: boolean) => (inactive ? { inert: true, "aria-hidden": true, tabIndex: -1 } : {});

/**
 * Background-task tray above the composer with three views: `dot` (all finished), `strip` (one-line chip)
 * and `bar` (row list). Dot -> strip -> bar, one step per tap. View logic is the pure `trayMode.ts`; this component only renders it.
 */
export function TaskTray({ sessionId, groups, total, known, pref, onPrefChange, taskViewOpen, onOpenTask, focusComposer }: TaskTrayProps) {
  // Last-known groups survive a reconnect reset (tasks -> undefined) so nothing flaps.
  const last = useRef({ sessionId, groups: EMPTY, total: 0 });
  if (last.current.sessionId !== sessionId) last.current = { sessionId, groups: EMPTY, total: 0 };
  if (known) last.current = { sessionId, groups, total };
  const view = known ? { groups, total } : last.current;
  const g = view.groups;

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cls = known ? classify(view.total, g.live.length) : undefined;
  const { mode, dispatch, rootHandlers, listHandlers } = useTrayMode({
    sessionId,
    cls,
    pref,
    onWritePref: onPrefChange,
    viewOpen: taskViewOpen,
    rootRef,
    focusComposer,
  });
  const isBar = mode === "bar";
  const listMounted = useDelayedUnmount(isBar, 270);
  // Enter animation: the list mounts closed (0fr), a forced reflow commits that, then it opens, so the
  // footer grows over the transition and MessageList's ResizeObserver re-pins the chat each frame.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => {
    if (!listMounted) {
      setEntered(false);
      return;
    }
    void wrapRef.current?.getBoundingClientRect();
    setEntered(true);
  }, [listMounted]);

  const now = useSecondTick(g.running.length > 0 && mode !== "dot" && mode !== "hidden");
  const rows = useMemo<TaskSummary[]>(() => [...g.live, ...g.finished], [g.live, g.finished]);
  const nav = useRovingListNav(
    useMemo(() => rows.map((t) => ({ path: t.id })), [rows]),
    { onOpen: onOpenTask },
  );

  // Arrow keys move the cursor; follow it with DOM focus while focus is inside the list.
  const { cursorPath } = nav;
  useEffect(() => {
    const el = listRef.current;
    if (!el || cursorPath === null || !el.contains(document.activeElement)) return;
    el.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(cursorPath)}"]`)?.focus();
  }, [cursorPath]);

  if (mode === "hidden") return null;

  const hasAccent = g.running.length > 0;
  const summary = summaryText(g);
  const panelId = `task-tray-list-${sessionId}`;
  const isStrip = mode === "strip";
  const toggle = (active: boolean) => ({ "data-tray-toggle": "", "data-active": active ? "true" : "false", ...inertProps(!active) });

  const renderRow = (t: TaskSummary) => {
    const quiet = isQuiet(t, now);
    return (
      <button
        key={t.id}
        type="button"
        className={`task-tray__row${t.state === "running" ? "" : " task-tray__row--finished"}`}
        data-task-id={t.id}
        data-testid="task-row"
        aria-label={rowAriaLabel(t, now)}
        tabIndex={nav.isTabbable(t.id) ? 0 : -1}
        onFocus={() => nav.setCursorPath(t.id)}
        onClick={() => onOpenTask(t.id)}
      >
        <TaskIcon state={t.state} quiet={quiet} size={12} label={false} />
        <span className={`task-tray__row-label${t.kind === "command" ? " task-tray__row-label--mono" : ""}`}>{t.label}</span>
        <span className="task-tray__row-kind">{t.kind === "command" ? "command" : t.kind}</span>
        {t.reason ? <span className="task-tray__row-reason">{t.reason}</span> : null}
        <span className="task-tray__row-meta">{rowMeta(t, now)}</span>
        <ChevronRight size={12} aria-hidden />
      </button>
    );
  };

  const title = `Background${summary ? ` · ${summary}` : ""}`;

  return (
    <div className="task-tray" data-testid="task-tray" data-mode={mode} ref={rootRef} {...rootHandlers}>
      <button
        type="button"
        className="task-tray__dot"
        data-testid="task-tray-dot"
        {...toggle(mode === "dot")}
        aria-label={`Background tasks, ${summary}. Show`}
        onClick={() => dispatch({ type: "tapDot" })}
      >
        <ListChecks size={14} aria-hidden />
      </button>
      <div className="task-tray__reveal">
        <div className="task-tray__clip">
          <div className="task-tray__shell">
            <button
              type="button"
              className="task-tray__chip"
              data-testid="task-tray-chip"
              {...toggle(isStrip)}
              aria-expanded={false}
              aria-label={`Background tasks, ${summary}. Expand`}
              onClick={() => dispatch({ type: "tapStrip" })}
            >
              <span className="task-tray__lead">{hasAccent ? <TaskIcon state="running" quiet={false} size={14} label={false} /> : null}</span>
              <span className="task-tray__chip-count">{summary}</span>
              <span className="task-tray__chip-labels">{chipLabels(g.live.length ? g.live : g.finished, now)}</span>
              <ChevronUp size={14} aria-hidden />
            </button>
            <div
              className="task-tray__head"
              data-testid="task-tray-head"
              data-active={isBar ? "true" : "false"}
              {...(isBar ? {} : { inert: true, "aria-hidden": true })}
            >
              <span className="task-tray__lead">
                {hasAccent ? <TaskIcon state="running" quiet={false} size={14} label={false} /> : null}
              </span>
              <span className="task-tray__head-title">{title}</span>
              <button
                type="button"
                className="task-tray__close"
                data-testid="task-tray-close"
                data-tray-toggle=""
                data-active={isBar ? "true" : "false"}
                aria-expanded
                {...(isBar && listMounted ? { "aria-controls": panelId } : {})}
                aria-label="Collapse background tasks"
                tabIndex={isBar ? 0 : -1}
                onClick={() => dispatch({ type: "tapHeader" })}
              >
                <ChevronDown size={14} aria-hidden />
              </button>
            </div>
            {listMounted ? (
              <div className="task-tray__listwrap" ref={wrapRef} data-open={isBar && entered ? "true" : "false"} {...(isBar ? {} : { inert: true })}>
                <div
                  className="task-tray__list"
                  id={panelId}
                  ref={listRef}
                  role="group"
                  aria-label="Background tasks"
                  onScroll={listHandlers.onScroll}
                  onKeyDown={nav.handleKeyDown}
                >
                  {g.live.map(renderRow)}
                  {g.finished.length > 0 ? (
                    <>
                      <div className="task-tray__group" data-testid="task-tray-finished">
                        Finished
                      </div>
                      {g.finished.map(renderRow)}
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
