import { useMemo, useState } from "react";
import type { NormalizedEvent } from "@/api/types";
import { extractTodos, isTodoToolName, type TodoItem } from "./toolFormat";

interface TodoStripProps {
  /** Full normalized event stream for the session (replay + live). */
  events: NormalizedEvent[];
  /** Resolved lifecycle state — `sessionStates[id] ?? session.state`. */
  liveState?: string;
}

/**
 * Persistent TODO strip pinned above the composer: shows the agent's *current*
 * plan for this session, whenever a todo snapshot exists — so a finished plan
 * stays visible for review. It renders the **most recent** todoWrite snapshot
 * in the transcript ("last snapshot wins" — opencode re-sends the full list
 * every update, delivered in the tool_result's refined input).
 *
 * Dismissal: when the agent yields back to the human (`waiting_for_human`) a
 * close button appears; dismissing hides the strip until a NEW todoWrite
 * snapshot arrives (the next resumed turn), at which point it reappears with
 * the updated plan. There is no reliable "all todos done" event, so the strip
 * never auto-hides on completion.
 */
export function TodoStrip({ events, liveState }: TodoStripProps) {
  // The latest todo snapshot: its stable event id (for dismissal tracking) and
  // the derived items. `undefined` when the session has no todo data at all.
  const snapshot = useMemo<{ key: string; items: TodoItem[] } | undefined>(() => {
    // opencode's `todowrite` delivers the list in the tool_RESULT event's
    // refined `toolInput` (`{ todos: [{content,status,priority}, ...] }`), with
    // the `tool_use` itself carrying an empty `{}`. Track which tool ids are
    // todo calls so we can read their results. Scan newest-first so the last
    // snapshot wins.
    const todoToolIds = new Set<string>();
    for (const ev of events) {
      if (ev.kind === "tool_use" && ev.toolId && isTodoToolName(ev.toolName)) {
        todoToolIds.add(ev.toolId);
      }
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.kind === "tool_use" && ev.toolName && isTodoToolName(ev.toolName)) {
        const todos = extractTodos(ev.toolName, ev.toolInput, ev.toolResult?.content);
        if (todos && todos.length > 0) return { key: ev.id, items: todos };
      }
      if (ev.kind === "tool_result" && ev.toolId && todoToolIds.has(ev.toolId)) {
        const todos = extractTodos("todowrite", ev.toolInput, ev.toolResult?.content);
        if (todos && todos.length > 0) return { key: ev.id, items: todos };
      }
    }
    return undefined;
  }, [events]);

  // Dismissal is keyed to a specific snapshot: closing hides the strip until a
  // DIFFERENT snapshot (a new todoWrite) arrives, then it reappears.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const showClose = liveState === "waiting_for_human";
  const dismissed = snapshot !== undefined && dismissedKey === snapshot.key;
  const canClose = snapshot !== undefined && showClose;

  if (!snapshot || dismissed) return null;

  const { items } = snapshot;
  const doneCount = items.filter((t) => t.state === "done").length;

  return (
    <div className="chat-todo-strip" role="status" aria-label="Agent TODO list">
      <div className="chat-todo-strip__label">TODO</div>
      <ul className="chat-todo-strip__list">
        {items.map((item, i) => (
          <li
            key={`${i}-${item.text}`}
            className={`chat-todo-strip__item chat-todo-strip__item--${item.state}`}
          >
            <span className="chat-todo-strip__marker" aria-hidden>
              {item.state === "done" ? "✓" : item.state === "active" ? "▸" : "○"}
            </span>
            <span className="chat-todo-strip__text">{item.text}</span>
          </li>
        ))}
      </ul>
      <div className="chat-todo-strip__progress">
        {doneCount}/{items.length}
      </div>
      {canClose ? (
        <button
          type="button"
          className="chat-todo-strip__close"
          aria-label="Dismiss TODO list"
          onClick={() => setDismissedKey(snapshot.key)}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
