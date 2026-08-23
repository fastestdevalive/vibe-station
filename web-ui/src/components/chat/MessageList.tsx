import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Attachment, NormalizedEvent } from "@/api/types";
import type { PendingTurn } from "@/hooks/useChat";
import { TextMessage } from "./TextMessage";
import { QueuedTurnEditor } from "./QueuedTurnEditor";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolRunSummary } from "./ToolRunSummary";
import { ErrorCard } from "./ErrorCard";
import type { ToolCallEntry } from "./toolFormat";

type RenderItem =
  | { type: "user"; id: string; text: string; attachments?: Attachment[]; turnId?: string; cancelled?: boolean }
  | { type: "assistant"; id: string; text: string; turnId?: string }
  | { type: "thinking"; id: string; text: string; turnId?: string }
  | ({ type: "tool" } & ToolCallEntry)
  | { type: "toolRun"; id: string; tools: ToolCallEntry[] }
  | { type: "error"; id: string; text: string }
  | { type: "status"; id: string; text: string };

/**
 * Consecutive `tool` items (no text/user message, and no turn boundary,
 * between them) collapse into one `toolRun` item — rendered as a single
 * integrated, borderless summary line (e.g. "Read 1 file, ran 2 shell
 * commands") instead of separately-bordered tool cards, matching Claude
 * Code's native terminal transcript. Even a lone tool call becomes a
 * (single-entry) `toolRun` so its look is consistent regardless of whether
 * anything ran alongside it.
 *
 * An empty/signature-only `thinking` item (no text — a redacted or
 * signature-only reasoning block, common between near-every tool call in
 * some sessions) carries no information, so it's transparent to an
 * in-progress run: it's dropped rather than splitting one logical burst of
 * tool calls into several single-tool runs.
 */
export function mergeToolRuns(items: RenderItem[]): RenderItem[] {
  const out: RenderItem[] = [];
  let run: Extract<RenderItem, { type: "tool" }>[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    out.push(run.length === 1 ? { type: "toolRun", id: run[0]!.id, tools: [run[0]!] } : { type: "toolRun", id: run[0]!.id, tools: [...run] });
    run = [];
  };
  for (const item of items) {
    if (item.type === "thinking" && item.text.trim().length === 0 && run.length > 0) {
      continue;
    }
    // A run never spans a turn boundary — two tool calls from different
    // turns just happening to be adjacent (nothing else rendered between
    // them) shouldn't visually merge into one group.
    if (item.type === "tool" && (run.length === 0 || run[run.length - 1]!.turnId === item.turnId)) {
      run.push(item);
    } else {
      flushRun();
      if (item.type === "tool") run.push(item);
      else out.push(item);
    }
  }
  flushRun();
  return out;
}

/**
 * Fold the flat normalized-event stream into renderable items: consecutive
 * assistant `text` / `thinking` events collapse into one bubble, and each
 * `tool_result` attaches to its `tool_use` by `toolId`. Meta-only kinds
 * (session_init / usage / result) feed the status bar, not the list. A `status`
 * event carrying text (e.g. a stopped-turn marker) renders as a subtle note so a
 * stopped turn reads as terminal rather than truncated.
 */
/** Benign claude rate-limit heartbeats that were persisted into old transcripts
 *  before RA6 stopped emitting them — noise, not actionable throttling. */
function isBenignRateLimit(text: string): boolean {
  return /^rate limit:\s*(unknown|allowed)/i.test(text.trim());
}

export function groupEvents(events: NormalizedEvent[]): RenderItem[] {
  const items: RenderItem[] = [];
  const toolIndexById = new Map<string, number>();
  // A superseding (edited) `user` event carries the same turnId — keep the bubble
  // at its FIRST position but update to the LATEST text/attachments (A7).
  const userIndexByTurnId = new Map<string, number>();

  for (const ev of events) {
    // Guard: a superseded (forked-away) event never renders (R3.4). The daemon
    // already excludes these from replay; this is a belt-and-suspenders filter.
    if (ev.superseded) continue;
    switch (ev.kind) {
      case "user": {
        if (ev.turnId) {
          const existingIdx = userIndexByTurnId.get(ev.turnId);
          if (existingIdx != null) {
            const existing = items[existingIdx];
            if (existing && existing.type === "user") {
              existing.text = ev.text ?? "";
              existing.attachments = ev.attachments;
              existing.id = ev.id;
              existing.cancelled = ev.cancelled;
            }
            break;
          }
        }
        items.push({
          type: "user",
          id: ev.id,
          text: ev.text ?? "",
          attachments: ev.attachments,
          ...(ev.turnId ? { turnId: ev.turnId } : {}),
          ...(ev.cancelled ? { cancelled: true } : {}),
        });
        if (ev.turnId) userIndexByTurnId.set(ev.turnId, items.length - 1);
        break;
      }
      case "text": {
        const last = items[items.length - 1];
        // Merge streaming deltas WITHIN a turn, but a new turn always starts a
        // fresh bubble — otherwise back-to-back replies (e.g. answers to several
        // queued messages, with only meta events between them) run together.
        if (last && last.type === "assistant" && last.turnId === ev.turnId) {
          last.text += ev.text ?? "";
        } else {
          items.push({ type: "assistant", id: ev.id, text: ev.text ?? "", turnId: ev.turnId });
        }
        break;
      }
      case "thinking": {
        const last = items[items.length - 1];
        if (last && last.type === "thinking" && last.turnId === ev.turnId) {
          last.text += ev.text ?? "";
        } else {
          items.push({ type: "thinking", id: ev.id, text: ev.text ?? "", turnId: ev.turnId });
        }
        break;
      }
      case "tool_use": {
        items.push({ type: "tool", id: ev.id, toolName: ev.toolName ?? "tool", toolInput: ev.toolInput, turnId: ev.turnId });
        if (ev.toolId) toolIndexById.set(ev.toolId, items.length - 1);
        break;
      }
      case "tool_result": {
        const result = { content: ev.toolResult?.content, isError: ev.toolResult?.isError };
        const idx = ev.toolId ? toolIndexById.get(ev.toolId) : undefined;
        const target = idx != null ? items[idx] : undefined;
        if (target && target.type === "tool") {
          target.result = result;
        } else {
          items.push({ type: "tool", id: ev.id, toolName: ev.toolName ?? "tool", result, turnId: ev.turnId });
        }
        break;
      }
      case "error":
        items.push({ type: "error", id: ev.id, text: ev.text ?? "" });
        break;
      case "status":
        // Only surface a status marker that carries text (e.g. "Turn stopped");
        // transient/empty status signals stay meta-only. Benign claude rate-limit
        // heartbeats (RA6 stops emitting these, but old transcripts persisted
        // "rate limit: unknown"/"allowed" noise) are filtered on render too so
        // history reads clean — real throttles (rejected/throttled/queued) show.
        if (ev.text && !isBenignRateLimit(ev.text)) {
          items.push({ type: "status", id: ev.id, text: ev.text });
        }
        break;
      default:
        // session_init / usage / result — not rendered as bubbles.
        break;
    }
  }
  return items;
}

/** A subtle "the agent is thinking on this point" affordance, anchored right
 *  below the most-recent user message (Change 3). Presence-only — the streaming
 *  ThinkingBlock renders the actual thinking content below it. */
function ThinkingHint() {
  return (
    <div className="chat-thinking-hint" role="status" aria-live="polite">
      <span className="chat-thinking-hint__dot" aria-hidden />
      Thinking…
    </div>
  );
}

/** Milliseconds each dot-count step of `WorkingIndicator` is shown. */
const WORKING_INDICATOR_STEP_MS = 450;

/** Persistent "agent is working" affordance pinned as the LAST item in the
 *  feed while a turn is active — the footer `StatusBar` spinner (near Stop)
 *  is easy to miss when scrolled up or glancing away from the composer; this
 *  is the same `turnActive` signal, just anchored where the eye actually
 *  lands. Dot COUNT cycles 1 → 2 → 3 → 1 (not a spinner) — only mounted
 *  while busy (see call site), so the interval's lifetime is the busy
 *  window, no separate start/stop wiring needed. */
function WorkingIndicator() {
  const [count, setCount] = useState(1);
  useEffect(() => {
    // Respect the same reduced-motion convention as `.chat-thinking-hint__dot`
    // (chat.css) — that one is stoppable via a CSS media query since its
    // motion is CSS-driven; this one's motion is a JS interval, so it needs
    // its own explicit check to honor the same opt-out.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      setCount((c) => (c >= 3 ? 1 : c + 1));
    }, WORKING_INDICATOR_STEP_MS);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="chat-working-indicator" role="status" aria-live="polite" aria-label="Agent is working">
      <span className="chat-working-indicator__dots" aria-hidden>
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className={`chat-working-indicator__dot${n <= count ? " chat-working-indicator__dot--on" : ""}`}
          />
        ))}
      </span>
    </div>
  );
}

/** Loaded-turn count above which the "load all" escape hatch warns (R2.5). */
const LOAD_ALL_WARN_TURNS = 200;

interface MessageListProps {
  events: NormalizedEvent[];
  /** Optimistic user turns that are NOT queued (queued ones live in the tray). */
  pending: PendingTurn[];
  /** True while a turn is active — the trailing tool card shows a spinner. */
  turnActive?: boolean;
  /** True while the active turn is in the pre-stream "thinking" state (Change 3). */
  thinking?: boolean;
  /** turnIds shown in the queued tray — filtered out of the inline chat log. */
  hiddenTurnIds?: ReadonlySet<string>;
  /** True when older history exists before the loaded window (R2.2). */
  hasMore?: boolean;
  /** True while a load-earlier / load-all fetch is in flight. */
  loadingEarlier?: boolean;
  /** Fetch + prepend the previous keyset page. */
  onLoadEarlier?: () => void;
  /** Guarded escape hatch: load the whole transcript. */
  onLoadAll?: () => void;
  onRetry?: () => void;
  /** API + session for the inline fork editor (edit an answered message). */
  api?: ApiInstance;
  sessionId?: string;
  /** Edit an already-answered user turn → fork (R3.1). When provided, answered
   *  user bubbles show an Edit affordance; only enabled while the session is idle. */
  onForkTurn?: (turnId: string, message: string, attachmentIds: string[]) => Promise<void> | void;
}

export function MessageList({
  events,
  pending,
  turnActive,
  thinking,
  hiddenTurnIds,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
  onLoadAll,
  onRetry,
  api,
  sessionId,
  onForkTurn,
}: MessageListProps) {
  // Which answered user turn (if any) this tab is editing → fork. Local to the
  // list; a fork closes the editor and the daemon truncates + re-runs (R3.1).
  const [forkEditingTurnId, setForkEditingTurnId] = useState<string | null>(null);
  // Forking is only offered when the session is idle (no turn in flight) — an
  // "answered" message (J6). Attachments/composer reuse the queued-turn editor.
  const canFork = !!onForkTurn && !!api && !!sessionId && !turnActive;
  const grouped = useMemo(() => groupEvents(events), [events]);
  // Queued / editing user turns render in the tray above the composer, not in
  // the log. Filter after grouping so the A7 edited-turn dedupe still applies.
  const items = useMemo(() => {
    const filtered =
      hiddenTurnIds && hiddenTurnIds.size > 0
        ? grouped.filter((it) => it.type !== "user" || !it.turnId || !hiddenTurnIds.has(it.turnId))
        : grouped;
    return mergeToolRuns(filtered);
  }, [grouped, hiddenTurnIds]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
    // `turnActive` here so the new WorkingIndicator's own appear/disappear
    // (it changes the feed's content height) re-triggers the scroll too.
  }, [items.length, pending.length, thinking, turnActive]);

  // Re-scroll to bottom when the SCROLL CONTAINER's own height changes (e.g.
  // the footer below it grows/shrinks — composer auto-grow, StatusBar
  // wrapping) — but only if the user is CURRENTLY near the bottom, so a
  // growing footer never fights someone reading scrolled-up history.
  // `.chat-message-list` (this component's root, via `listRef`) is unscrolled
  // content; its parent is the `overflow-y: auto` element (`.chat-pane__body`,
  // owned by `ChatPane.tsx`). Scoped via DOM traversal from this instance's
  // own root rather than a global selector, since multiple chat panes can be
  // mounted at once (canvas/workspace mode).
  //
  // Distance-to-bottom is computed FRESH inside the ResizeObserver callback,
  // not cached from a scroll listener: streaming tokens into an existing
  // assistant bubble grows content without moving `scrollTop` and without
  // firing a `scroll` event, so a cached flag can go stale-true while the
  // user has silently drifted away from the bottom — the observer callback
  // always runs with current layout, so this read is free and always correct.
  useEffect(() => {
    const container = listRef.current?.parentElement;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distance < 80) {
        // Not `bottomRef.current.scrollIntoView(...)`: that walks EVERY
        // scrollable ancestor (including `overflow: hidden` boxes, which are
        // still programmatically scrollable), so an unrelated resize (a
        // workspace-canvas divider drag, a sidebar collapse) could nudge
        // ancestor scroll positions too. Scrolling just this one container
        // keeps the effect local to the chat pane.
        container.scrollTop = container.scrollHeight;
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Anchor the thinking hint under the latest user message. When an optimistic
  // (non-queued) pending bubble exists, the newest user message is that pending
  // block, so the hint goes after it; otherwise after the last user item.
  const lastUserIdx = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.type === "user") return i;
    }
    return -1;
  }, [items]);
  const hintAfterPending = !!thinking && pending.length > 0;
  const hintAfterItem = !!thinking && !hintAfterPending && lastUserIdx >= 0;

  // Distinct loaded turns — the "load all" hatch warns once the window is large.
  const loadedTurns = useMemo(() => {
    const ids = new Set<string>();
    for (const ev of events) if (ev.turnId) ids.add(ev.turnId);
    return ids.size;
  }, [events]);

  return (
    <div ref={listRef} className="chat-message-list" role="log" aria-label="Conversation">
      {hasMore && onLoadEarlier ? (
        <div className="chat-load-earlier">
          <button
            type="button"
            className="chat-load-earlier__btn"
            onClick={onLoadEarlier}
            disabled={loadingEarlier}
          >
            {loadingEarlier ? "Loading…" : "Load earlier messages"}
          </button>
          {loadedTurns > LOAD_ALL_WARN_TURNS && onLoadAll ? (
            <button
              type="button"
              className="chat-load-earlier__all"
              onClick={onLoadAll}
              disabled={loadingEarlier}
              title="Loading the entire history may be slow on very long chats."
            >
              Load entire history
            </button>
          ) : null}
        </div>
      ) : null}

      {items.flatMap((item, i) => {
        const key = item.type === "user" ? item.turnId ?? item.id : item.id;
        let node: React.ReactNode;
        switch (item.type) {
          case "user": {
            // A cancelled queued turn stays in history but was never processed —
            // render it muted with a marker, and never fork-editable.
            if (item.cancelled) {
              node = (
                <div key={key} className="chat-user-turn chat-user-turn--cancelled" data-role="user">
                  <TextMessage role="user" text={item.text} attachments={item.attachments} />
                  <span className="chat-user-turn__cancelled" title="This message was cancelled before the agent processed it.">
                    Canceled · not sent to agent
                  </span>
                </div>
              );
              break;
            }
            const forkable = canFork && !!item.turnId;
            if (forkable && forkEditingTurnId === item.turnId) {
              node = (
                <div key={key} className="chat-msg chat-msg--user chat-msg--forking" data-role="user">
                  <QueuedTurnEditor
                    api={api!}
                    sessionId={sessionId!}
                    initialText={item.text}
                    initialAttachments={item.attachments ?? []}
                    onSave={async (message, attachments) => {
                      setForkEditingTurnId(null);
                      await onForkTurn!(item.turnId!, message, attachments.map((a) => a.id));
                    }}
                    onDiscard={() => setForkEditingTurnId(null)}
                  />
                </div>
              );
            } else if (forkable) {
              node = (
                <div key={key} className="chat-user-turn">
                  <TextMessage role="user" text={item.text} attachments={item.attachments} />
                  <button
                    type="button"
                    className="chat-user-turn__edit"
                    aria-label="Edit message (fork)"
                    title="Edit this message and re-run from here (fork)"
                    onClick={() => setForkEditingTurnId(item.turnId!)}
                  >
                    ✎
                  </button>
                </div>
              );
            } else {
              node = <TextMessage key={key} role="user" text={item.text} attachments={item.attachments} />;
            }
            break;
          }
          case "assistant":
            node = <TextMessage key={key} role="assistant" text={item.text} />;
            break;
          case "thinking":
            node = <ThinkingBlock key={key} text={item.text} />;
            break;
          case "toolRun":
            // "Live" means this run is the trailing item of an active turn —
            // any tool inside it still missing a result is genuinely running
            // (turns can fire several tool calls before results land), not
            // just the last one in the run.
            node = <ToolRunSummary key={key} tools={item.tools} live={!!turnActive && i === items.length - 1} />;
            break;
          case "error":
            node = <ErrorCard key={key} text={item.text} onRetry={onRetry} />;
            break;
          case "status":
            node = (
              <div key={key} className="chat-status-note" role="note">
                {item.text}
              </div>
            );
            break;
          default:
            node = null;
        }
        return hintAfterItem && i === lastUserIdx
          ? [node, <ThinkingHint key={`${key}-thinking`} />]
          : node;
      })}

      {pending.map((p) => (
        <div key={p.turnId} className="chat-pending">
          <TextMessage role="user" text={p.message} attachments={p.attachments} pending />
        </div>
      ))}

      {hintAfterPending ? <ThinkingHint /> : null}

      {/* Not during `thinking`: `ThinkingHint` already anchors a "Thinking…"
          affordance above for that sub-state — showing both at once would be
          two competing busy indicators on screen simultaneously. */}
      {turnActive && !thinking ? <WorkingIndicator /> : null}

      <div ref={bottomRef} />
    </div>
  );
}
