import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronLeft, Copy, Square } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { TaskSummary } from "@/api/types";
import { useIsTouch } from "@/hooks/useIsTouch";
import { useNowTick } from "@/hooks/useNowTick";
import { useWorkspaceStore } from "@/hooks/useStore";
import { copyText } from "@/lib/copyText";
import { TaskIcon } from "./TaskIcon";
import { TaskOutputLog } from "./TaskOutputLog";
import { cleanedText } from "./outputClean";
import { countsText, isQuiet, stateText, stateWord, toMs, type TaskGroups } from "./taskFormat";
import { useSecondTick } from "./useSecondTick";
import { useTaskEsc } from "./useTaskEsc";

export interface TaskViewProps {
  api: ApiInstance;
  sessionId: string;
  sessionName: string;
  task: TaskSummary;
  groups: TaskGroups;
  onClose: () => void;
  /** Same gate as the composer's `focusOnMount` (never steal focus in canvas mode). */
  focusOnMount: boolean;
}

/** Full-window task view: absolutely positioned over `.chat-pane` (the chat underneath stays mounted). */
export function TaskView({ api, sessionId, sessionName, task, groups, onClose, focusOnMount }: TaskViewProps) {
  const isTouch = useIsTouch();
  const rootRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const linesRef = useRef<string[]>([]);
  const [hasLines, setHasLines] = useState(false);
  const [copied, setCopied] = useState(false);
  const minute = useNowTick();
  const live = task.state === "running" && !isQuiet(task, minute);
  const now = useSecondTick(live);
  const quiet = isQuiet(task, now);
  const activeSession = useWorkspaceStore((s) => s.activeSessionId === sessionId);
  const esc = useTaskEsc({ onClose, enabled: true, isActiveSession: activeSession });

  useEffect(() => {
    if (focusOnMount && !isTouch) rootRef.current?.focus();
    // Focus once per opened task, not on every re-render of the same task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const startedMs = toMs(task.startedAt);
  const startedAt = startedMs !== undefined ? new Date(startedMs).toLocaleTimeString() : undefined;

  return (
    <div
      ref={rootRef}
      className="task-view"
      role="region"
      aria-label={`Task: ${task.label}`}
      data-testid="task-view"
      data-open-task-id={task.id}
      tabIndex={-1}
      onKeyDown={esc.onKeyDown}
    >
      <header className="task-view__header">
        <TaskIcon state={task.state} quiet={quiet} size={18} />
        <div className="task-view__title">
          <span className={`task-view__label${task.kind === "command" ? " task-view__label--mono" : ""}`}>{task.label}</span>
          <span className="task-view__state" data-testid="task-view-state">
            {stateText(task, now)}
            {startedAt ? <span className="task-view__started"> · started {startedAt}</span> : null}
          </span>
          {task.outputKind === "file" && task.outputPath ? (
            <span className="task-view__path" title={task.outputPath} data-testid="task-view-path">
              Full log: {task.outputPath}
            </span>
          ) : null}
          {/* Only the state word is announced; the ticking elapsed text above stays outside the live region. */}
          <span className="task-view__sr" aria-live="polite" data-testid="task-view-state-live">
            {stateWord(task.state, quiet)}
          </span>
        </div>
      </header>

      <TaskOutputLog
        api={api}
        sessionId={sessionId}
        task={task}
        now={now}
        secondPrecision={live}
        actions={
          <>
            <button
              type="button"
              className="task-view__icon-btn"
              aria-label={copied ? "Copied" : "Copy output"}
              title={copied ? "Copied" : hasLines ? "Copy output (last 200 lines shown)" : "Nothing to copy yet"}
              aria-disabled={!hasLines || undefined}
              data-testid="task-copy"
              onClick={() => {
                if (!hasLines) return;
                void copyText(cleanedText(linesRef.current)).then((ok) => setCopied(ok));
              }}
            >
              {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            </button>
            <button
              type="button"
              className="task-view__icon-btn"
              aria-label="Stop task"
              title="Stop — not supported by this agent version"
              aria-disabled={!task.canStop || undefined}
              aria-describedby={hintId}
              data-testid="task-stop"
              onClick={(e) => e.preventDefault()}
            >
              <Square size={13} aria-hidden />
            </button>
            <span id={hintId} className="task-view__sr">
              Not supported by this agent version
            </span>
          </>
        }
        onShownChange={(l) => {
          linesRef.current = l;
          setHasLines(l.length > 0);
        }}
      />

      <nav className="task-view__crumbs" aria-label="Breadcrumb">
        <button type="button" className="task-view__back" aria-label="Back to chat" data-testid="task-back" onClick={onClose}>
          <ChevronLeft size={12} aria-hidden />
          Back to chat
          {!isTouch ? <kbd>Esc</kbd> : null}
        </button>
        <span className="task-view__sep" aria-hidden>/</span>
        <span className="task-view__crumb task-view__crumb--trunc">{sessionName}</span>
        <span className="task-view__sep" aria-hidden>/</span>
        <span className="task-view__crumb">Tasks</span>
        <span className="task-view__sep" aria-hidden>/</span>
        <span
          className={`task-view__crumb task-view__crumb--current task-view__crumb--trunc${task.kind === "command" ? " task-view__crumb--mono" : ""}`}
        >{task.label}</span>
        <span className="task-view__spacer" />
        <span className="task-view__counts">
          {countsText(groups)}
        </span>
      </nav>
      <div className="task-view__composer" aria-disabled="true" data-testid="task-view-composer">
        {isTouch
          ? "Viewing task output. Tap Back to chat to message the agent."
          : "Viewing task output. Press Esc to go back to the chat and message the agent."}
      </div>
    </div>
  );
}
