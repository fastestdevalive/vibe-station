import { useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import type { TaskSummary } from "@/api/types";
import { useRovingListNav } from "@/hooks/useRovingListNav";
import { TaskIcon } from "./TaskIcon";
import { useSecondTick } from "./useSecondTick";
import { chipLabels, isQuiet, rowAriaLabel, rowMeta, summaryText, type TaskGroups } from "./taskFormat";

export interface TaskTrayProps {
  groups: TaskGroups;
  total: number;
  expanded: boolean;
  onExpandedChange: (v: boolean) => void;
  onOpenTask: (id: string) => void;
  /** Esc on a row hands focus back to the composer (same as QueuedTray). */
  focusComposer?: () => void;
}

/** Tray of background tasks above the composer. Hidden when nothing is tracked. */
export function TaskTray({ groups, total, expanded, onExpandedChange, onOpenTask, focusComposer }: TaskTrayProps) {
  const now = useSecondTick(groups.running.length > 0);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo<TaskSummary[]>(() => [...groups.live, ...groups.finished], [groups.live, groups.finished]);
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

  if (total === 0) return null;

  const hasAccent = groups.running.length > 0;
  const summary = summaryText(groups);

  if (!expanded) {
    return (
      <div className="task-tray" data-testid="task-tray">
        <button
          type="button"
          className="task-tray__chip"
          data-testid="task-tray-chip"
          aria-expanded={false}
          aria-label={`Background tasks, ${summary}. Expand`}
          onClick={() => onExpandedChange(true)}
        >
          {hasAccent ? <TaskIcon state="running" quiet={false} size={14} label={false} /> : null}
          <span className="task-tray__chip-count">{summary}</span>
          <span className="task-tray__chip-labels">{chipLabels(groups.live.length ? groups.live : groups.finished, now)}</span>
          <ChevronUp size={14} aria-hidden />
        </button>
      </div>
    );
  }

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
        {t.state !== "running" && t.reason ? <span className="task-tray__row-reason">{t.reason}</span> : null}
        <span className="task-tray__row-meta">{rowMeta(t, now)}</span>
        <ChevronRight size={12} aria-hidden />
      </button>
    );
  };

  return (
    <div className="task-tray task-tray--open" data-testid="task-tray">
      <button
        type="button"
        className="task-tray__head"
        data-testid="task-tray-head"
        aria-expanded
        aria-label="Collapse background tasks"
        onClick={() => onExpandedChange(false)}
      >
        {hasAccent ? <TaskIcon state="running" quiet={false} size={14} label={false} /> : null}
        <span className="task-tray__head-title">Background{summary ? ` · ${summary}` : ""}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      <div
        className="task-tray__list"
        ref={listRef}
        role="group"
        aria-label="Background tasks"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            focusComposer?.();
            return;
          }
          nav.handleKeyDown(e);
        }}
      >
        {groups.live.map(renderRow)}
        {groups.finished.length > 0 ? (
          <>
            <div className="task-tray__group" data-testid="task-tray-finished">
              Finished
            </div>
            {groups.finished.map(renderRow)}
          </>
        ) : null}
      </div>
    </div>
  );
}
