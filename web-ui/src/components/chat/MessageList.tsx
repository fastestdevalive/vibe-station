import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Attachment, NormalizedEvent } from "@/api/types";
import type { PendingTurn } from "@/hooks/useChat";
import { TextMessage } from "./TextMessage";
import { QueuedTurnEditor } from "./QueuedTurnEditor";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolRunSummary } from "./ToolRunSummary";
import { ErrorCard } from "./ErrorCard";
import { WorkingDots } from "./WorkingDots";
import { blocksToPlaceholder, type ToolCallEntry } from "./toolFormat";

type RenderItem =
  | { type: "user"; id: string; text: string; attachments?: Attachment[]; turnId?: string; cancelled?: boolean }
  | { type: "assistant"; id: string; text: string; turnId?: string }
  | {
      type: "thinking";
      id: string;
      text: string;
      turnId?: string;
      startedTs: string;
      endedTs?: string;
      /** True when at least one tool call happened while this group was open —
       *  the completed label then reads "Worked for Xs" instead of "Thought
       *  for Xs", since the span covered real work, not just reasoning. */
      hadToolCall?: boolean;
      /** Whether this group is still empty AT THE POSITION IT OCCUPIES —
       *  set at push time, and cleared only by an append that lands while the
       *  group is still the trailing item (so its position is honest).
       *  `mergeToolRuns` drops such groups between tool calls, so an empty blip
       *  never fragments one logical tool run. Testing the item's current text
       *  at merge time instead would let text appended after an intervening
       *  tool call resurrect the group at its stale, too-early position. */
      openedEmpty: boolean;
    }
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
 * tool calls into several single-tool runs. The drop tests `openedEmpty`
 * (emptiness AT CREATION, see the RenderItem field) rather than the item's
 * current text: `groupEvents` can append later text into a group that was
 * empty when it took its position, and dropping THAT would render real,
 * late-arriving reasoning at a stale, too-early spot in the transcript.
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
    if (item.type === "thinking" && item.openedEmpty && run.length > 0) {
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
  // Same-turn thinking bursts merge into ONE RenderItem across intervening
  // tool_use/tool_result (a turn can reason, call a tool, then keep
  // reasoning about the result — that's still one logical "thinking" span
  // from the user's perspective). The group is closed DETERMINISTICALLY
  // inside this pure function — never by a later effect mutating the
  // memoized result (see MessageList's primary render for why that would be
  // unsound: it wouldn't survive the next `events` change, and it would
  // never resolve for a cold-loaded/replayed transcript at all).
  const thinkingOpenByTurnId = new Map<string, number>();
  function closeOpenThinking(turnId: string | undefined, ts: string) {
    if (!turnId) return;
    const openIdx = thinkingOpenByTurnId.get(turnId);
    const open = openIdx != null ? items[openIdx] : undefined;
    if (open && open.type === "thinking" && !open.endedTs) open.endedTs = ts;
    thinkingOpenByTurnId.delete(turnId);
  }
  /** Pure bookkeeping: mark the still-open thinking group of `turnId` (if any)
   *  as having spanned a tool call. Never touches control flow — tool events
   *  deliberately do NOT close the group (see the thinking case). */
  function markToolCallDuringThinking(turnId: string | undefined) {
    if (!turnId) return;
    const openIdx = thinkingOpenByTurnId.get(turnId);
    const open = openIdx != null ? items[openIdx] : undefined;
    if (open && open.type === "thinking" && !open.endedTs) open.hadToolCall = true;
  }

  for (const ev of events) {
    // Guard: a superseded (forked-away) event never renders (R3.4). The daemon
    // already excludes these from replay; this is a belt-and-suspenders filter.
    if (ev.superseded) continue;
    // Any event belonging to a DIFFERENT turn than a currently-open thinking
    // group implies that prior turn's reasoning is over (turns are strictly
    // sequential — one active turnId at a time per session) — close it before
    // handling this event, regardless of this event's own kind.
    if (ev.turnId) {
      for (const openTurnId of thinkingOpenByTurnId.keys()) {
        if (openTurnId !== ev.turnId) closeOpenThinking(openTurnId, ev.ts);
      }
    }
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
        // A real reply closes any open thinking group for this turn (Decision 3).
        closeOpenThinking(ev.turnId, ev.ts);
        const last = items[items.length - 1];
        // Merge streaming deltas WITHIN a turn, but a new turn always starts a
        // fresh bubble — otherwise back-to-back replies (e.g. answers to several
        // queued messages, with only meta events between them) run together.
        const incomingText = ev.text ?? (ev.blocks && ev.blocks.length > 0 ? blocksToPlaceholder(ev.blocks) : "");
        if (last && last.type === "assistant" && last.turnId === ev.turnId) {
          last.text += incomingText;
        } else {
          items.push({ type: "assistant", id: ev.id, text: incomingText, turnId: ev.turnId });
        }
        break;
      }
      case "thinking": {
        // Empty/signature-only thinking events (no text) DO open a group: they
        // are the common case for real Claude reasoning, and dropping them here
        // meant "Thought for Xs" never rendered for such a turn at all
        // (`ThinkingBlock`'s static, non-expandable branch was unreachable).
        // The noisy case — an empty blip sitting between two tool calls, which
        // would otherwise fragment one logical tool run — is already handled
        // downstream by `mergeToolRuns`' drop-rule above.
        const openIdx = ev.turnId ? thinkingOpenByTurnId.get(ev.turnId) : undefined;
        const open = openIdx != null ? items[openIdx] : undefined;
        const incoming = ev.text ?? (ev.blocks && ev.blocks.length > 0 ? blocksToPlaceholder(ev.blocks) : "");
        // Real text arriving into a group that opened EMPTY and no longer sits
        // at the end of the feed (a tool call has rendered since) must NOT be
        // appended: that group's position is stale, so the reasoning would show
        // up EARLIER than it was actually emitted — and, being empty at
        // creation, it may also be dropped outright by `mergeToolRuns`. Start a
        // fresh group at the current position instead. The abandoned empty
        // placeholder is either merged away between tool calls or hidden by the
        // render gate (empty + never closed → nothing to show).
        const staleEmptyGroup =
          open != null &&
          open.type === "thinking" &&
          open.openedEmpty &&
          incoming.trim().length > 0 &&
          openIdx !== items.length - 1;
        if (open && open.type === "thinking" && !open.endedTs && !staleEmptyGroup) {
          // Appends even across intervening tool_use/tool_result — those cases
          // don't call closeOpenThinking, so the group stays open through them.
          open.text += incoming;
          if (open.openedEmpty && open.text.trim().length > 0) open.openedEmpty = false;
        } else {
          items.push({
            type: "thinking",
            id: ev.id,
            text: incoming,
            turnId: ev.turnId,
            startedTs: ev.ts,
            openedEmpty: incoming.trim().length === 0,
          });
          if (ev.turnId) thinkingOpenByTurnId.set(ev.turnId, items.length - 1);
        }
        break;
      }
      case "tool_use": {
        markToolCallDuringThinking(ev.turnId);
        items.push({
          type: "tool",
          id: ev.id,
          toolName: ev.toolName ?? "tool",
          toolInput: ev.toolInput,
          turnId: ev.turnId,
          status: ev.toolStatus,
          diffs: ev.toolDiffs,
          locations: ev.toolLocations,
          toolKind: ev.toolKind,
        });
        if (ev.toolId) toolIndexById.set(ev.toolId, items.length - 1);
        break;
      }
      case "tool_result": {
        markToolCallDuringThinking(ev.turnId);
        const idx = ev.toolId ? toolIndexById.get(ev.toolId) : undefined;
        const target = idx != null ? items[idx] : undefined;
        if (target && target.type === "tool") {
          if (ev.toolResult !== undefined) {
            target.result = { content: ev.toolResult.content, isError: ev.toolResult.isError };
          }
          if (ev.toolStatus !== undefined) target.status = ev.toolStatus;
          if (ev.toolDiffs !== undefined) target.diffs = ev.toolDiffs;
          if (ev.toolLocations !== undefined) target.locations = ev.toolLocations;
          if (ev.toolKind !== undefined) target.toolKind = ev.toolKind;
        } else {
          items.push({
            type: "tool", id: ev.id, toolName: ev.toolName ?? "tool", turnId: ev.turnId,
            result: ev.toolResult !== undefined ? { content: ev.toolResult.content, isError: ev.toolResult.isError } : undefined,
            status: ev.toolStatus, diffs: ev.toolDiffs, locations: ev.toolLocations, toolKind: ev.toolKind,
          });
        }
        break;
      }
      case "error":
        closeOpenThinking(ev.turnId, ev.ts);
        items.push({ type: "error", id: ev.id, text: ev.text ?? "" });
        break;
      case "status":
        // Only surface a status marker that carries text (e.g. "Turn stopped");
        // transient/empty status signals stay meta-only. Benign claude rate-limit
        // heartbeats (RA6 stops emitting these, but old transcripts persisted
        // "rate limit: unknown"/"allowed" noise) are filtered on render too so
        // history reads clean — real throttles (rejected/throttled/queued) show.
        // The close call lives INSIDE this same condition, not unconditionally:
        // a benign heartbeat carries no visible content, so closing the open
        // thinking group on it would split one reasoning burst into
        // "Thought for Xs" + a fresh "Thinking…" with nothing rendered in
        // between to explain why — a real status (or any other event kind)
        // still closes the group as before.
        if (ev.text && !isBenignRateLimit(ev.text)) {
          closeOpenThinking(ev.turnId, ev.ts);
          items.push({ type: "status", id: ev.id, text: ev.text });
        }
        break;
      case "mode_update":
        closeOpenThinking(ev.turnId, ev.ts);
        items.push({ type: "status", id: ev.id, text: `Mode changed${ev.modeId ? ` to ${ev.modeId}` : ""}` });
        break;
      case "commands_update": {
        closeOpenThinking(ev.turnId, ev.ts);
        const names = (ev.commands ?? []).map((c) => c.name);
        const CAP = 8;
        const shown = names.slice(0, CAP).join(", ");
        const more = names.length > CAP ? ` (+${names.length - CAP} more)` : "";
        items.push({
          type: "status",
          id: ev.id,
          text: `${names.length} command${names.length === 1 ? "" : "s"} available${shown ? `: ${shown}${more}` : ""}`,
        });
        break;
      }
      default:
        // session_init / usage / result — not rendered as bubbles, but a
        // `result` event marks the turn as over, so close any open group.
        closeOpenThinking(ev.turnId, ev.ts);
        break;
    }
  }
  return items;
}

/** Persistent "agent is working" affordance pinned as the LAST item in the
 *  feed while a turn is active — the footer `StatusBar` spinner (near Stop)
 *  is easy to miss when scrolled up or glancing away from the composer; this
 *  is the same `turnActive` signal, just anchored where the eye actually
 *  lands. The dot-cycle itself lives in the shared `WorkingDots` (also used
 *  by the footer `StatusBar` when the user has scrolled away from this
 *  indicator); this component only adds the live region and the label. */
function WorkingIndicator({ label }: { label?: string }) {
  return (
    // The accessible name tracks `label`: a STATIC name on a live-region root
    // is what most assistive tech announces on change, which would suppress
    // the actual (changing) "Thinking"/"Running tool" text entirely.
    <div className="chat-working-indicator" role="status" aria-live="polite" aria-label={label ?? "Agent is working"}>
      {label ? <span className="chat-working-indicator__label">{label}</span> : null}
      <WorkingDots />
    </div>
  );
}

/** Loaded-turn count above which the "load all" escape hatch warns (R2.5). */
const LOAD_ALL_WARN_TURNS = 200;

/** Distance (px) from the TOP of the scroll container within which scrolling
 *  auto-triggers `onLoadEarlier` (infinite-scroll-upward). Deliberately the
 *  same 80px scale as the near-BOTTOM guard used by the auto-scroll effects
 *  below, so both edges feel symmetric. `onLoadAll` never auto-triggers — it
 *  is a guarded escape hatch (R2.5) and stays manual-only. */
const NEAR_TOP_PX = 80;

interface MessageListProps {
  events: NormalizedEvent[];
  /** Optimistic user turns that are NOT queued (queued ones live in the tray). */
  pending: PendingTurn[];
  /** True while a turn is active — the trailing tool card shows a spinner. */
  turnActive?: boolean;
  /** True while the active turn is in the pre-stream "thinking" state. No
   *  longer drives any rendering choice directly (the old `ThinkingHint` that
   *  consumed it as a boolean was removed) — kept only as a dependency of the
   *  primary auto-scroll effect below, so a thinking↔responding/tool flip
   *  still re-triggers that effect. */
  thinking?: boolean;
  /** Turn-state label (e.g. "Thinking"/"Responding"/"Running tool" — no
   *  trailing ellipsis; the animated dots carry the "in progress" sense) shown
   *  next to the dots in the trailing `WorkingIndicator` (Decision 8) — computed
   *  by `ChatPane` via the shared `turnLabel` export from `StatusBar.tsx`. */
  workingLabel?: string;
  /** turnIds shown in the queued tray — filtered out of the inline chat log. */
  hiddenTurnIds?: ReadonlySet<string>;
  /** True when older history exists before the loaded window (R2.2). */
  hasMore?: boolean;
  /** True while a load-earlier / load-all fetch is in flight. */
  loadingEarlier?: boolean;
  /** Fetch + prepend the previous keyset page. May return a promise — when it
   *  does, THAT promise (not the `loadingEarlier` prop's render transitions)
   *  is what releases the internal prepend-pending state. */
  onLoadEarlier?: () => void | Promise<void>;
  /** Guarded escape hatch: load the whole transcript. */
  onLoadAll?: () => void;
  onRetry?: () => void;
  /** API + session for the inline fork editor (edit an answered message). */
  api?: ApiInstance;
  sessionId?: string;
  /** Edit an already-answered user turn → fork (R3.1). When provided, answered
   *  user bubbles show an Edit affordance; only enabled while the session is idle. */
  onForkTurn?: (turnId: string, message: string, attachmentIds: string[]) => Promise<void> | void;
  /** Notified whenever the tracked near-bottom state changes (the same signal
   *  that drives the jump-to-bottom button). `ChatPane` mirrors it so the
   *  footer `StatusBar` can show busy dots exactly when the in-feed
   *  `WorkingIndicator` is scrolled out of view. */
  onAtBottomChange?: (atBottom: boolean) => void;
}

export function MessageList({
  events,
  pending,
  turnActive,
  thinking,
  workingLabel,
  hiddenTurnIds,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
  onLoadAll,
  onRetry,
  api,
  sessionId,
  onForkTurn,
  onAtBottomChange,
}: MessageListProps) {
  // Which answered user turn (if any) this tab is editing → fork. Local to the
  // list; a fork closes the editor and the daemon truncates + re-runs (R3.1).
  const [forkEditingTurnId, setForkEditingTurnId] = useState<string | null>(null);
  // Forking is only offered when the session is idle (no turn in flight) — an
  // "answered" message (J6). Attachments/composer reuse the queued-turn editor.
  const canFork = !!onForkTurn && !!api && !!sessionId && !turnActive;
  const grouped = useMemo(() => groupEvents(events), [events]);
  // The turnId of the turn that is actually running RIGHT NOW — the last
  // event carrying one, since turns are strictly sequential (one active
  // turnId at a time per session). Only meaningful while `turnActive`.
  const activeTurnId = useMemo(() => {
    if (!turnActive) return undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const id = events[i]?.turnId;
      if (id) return id;
    }
    return undefined;
  }, [events, turnActive]);
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
  const prevPendingLenRef = useRef(pending.length);
  // Whether the user is (or was, at last scroll) near the bottom of the
  // scroll container — drives both the jump-to-bottom button's visibility
  // AND the primary scroll effect's guard below. Initializes to `true`: no
  // `scroll` event has fired at mount, and a fresh chat open should snap to
  // the live edge like today's unconditional scroll did, not render at the
  // top of history (that would be a mount-time regression).
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  // Read through a ref so the once-registered scroll listener below (empty
  // deps, passive) never has to re-attach when the parent passes a new
  // callback identity.
  const onAtBottomChangeRef = useRef(onAtBottomChange);
  useEffect(() => {
    onAtBottomChangeRef.current = onAtBottomChange;
  }, [onAtBottomChange]);
  /** Single writer for the near-bottom state: keeps the ref (read by the
   *  layout effects), the local state (jump-to-bottom button) and the parent
   *  notification in lockstep. */
  const applyAtBottom = useCallback((next: boolean) => {
    // Only genuine transitions propagate — a `scroll` burst that never leaves
    // the near-bottom band would otherwise re-notify the parent on every
    // event, contradicting this callback's own contract ("notified whenever
    // the tracked state CHANGES").
    if (next === atBottomRef.current) return;
    atBottomRef.current = next;
    setAtBottom(next);
    onAtBottomChangeRef.current?.(next);
  }, []);

  // --- infinite-scroll-upward (auto "load earlier") state ---------------
  // Set the moment a load-earlier is initiated (by the scroll trigger OR the
  // manual button) and cleared once the prepended page has rendered. Doubles
  // as the in-flight guard for the auto-trigger: a burst of scroll events
  // near the top can't fan out into several overlapping fetches in the frames
  // before the `loadingEarlier` prop has propagated back down from `useChat`.
  const prependPendingRef = useRef(false);
  // Whether we've observed `loadingEarlier` go true for the pending load —
  // so a trigger the parent silently no-ops (no session / cursor) can't leave
  // a scroll-restore armed against some unrelated later growth.
  const sawLoadingRef = useRef(false);
  // Identifies the CURRENT pending load, so a stale settle callback from an
  // earlier (already-released) load can never release a later one.
  const loadTokenRef = useRef(0);
  // `scrollHeight` as of the END of the previous render, i.e. before the page
  // about to be prepended exists. Re-captured on EVERY render (not once at
  // trigger time) so height the feed gains at the BOTTOM while the fetch is in
  // flight — streaming tokens, a growing tool card — is already folded in and
  // never misattributed to the prepend. Same class of bug as the bottom-edge
  // fix in this file: never restore from a stale measurement.
  const prevScrollHeightRef = useRef(0);

  /** Clear the pending-prepend state and re-anchor the read position: whatever
   *  was on screen now sits `delta` px lower, so adding `delta` to `scrollTop`
   *  leaves it pixel-identical. Applied in BOTH directions — a prepend can be
   *  negative overall (a short page that also removes the `.chat-load-earlier`
   *  row when `hasMore` flips false), and skipping those left the view shifted.
   *
   *  Known limit of measuring total `scrollHeight`: if a live bottom-edge
   *  append (streaming tokens) commits in the SAME React batch as the prepend,
   *  its height is folded into `delta` and the restore over-shifts by that
   *  much. The per-render re-capture below keeps every OTHER frame of in-flight
   *  bottom growth out of `delta`; isolating that single same-batch commit
   *  would need per-item offset bookkeeping, which isn't worth it here. */
  const releasePendingPrepend = useCallback(() => {
    prependPendingRef.current = false;
    sawLoadingRef.current = false;
    const container = listRef.current?.parentElement;
    if (!container) return;
    const delta = container.scrollHeight - prevScrollHeightRef.current;
    if (delta !== 0) container.scrollTop += delta;
    prevScrollHeightRef.current = container.scrollHeight;
  }, []);

  const startLoadEarlier = useCallback(() => {
    if (prependPendingRef.current || loadingEarlier || !hasMore || !onLoadEarlier) return;
    prependPendingRef.current = true;
    sawLoadingRef.current = false;
    const token = ++loadTokenRef.current;
    // Settlement is observed on the triggered call ITSELF, not inferred from
    // the `loadingEarlier` prop's render transitions — a parent can
    // legitimately never render `loadingEarlier === true` (it early-returns
    // before flipping the flag when there's no session/cursor, throws first,
    // or resolves fast enough that true→false coalesces into one `false`
    // render). Any of those used to leave `prependPendingRef` set forever,
    // which permanently disabled BOTH the primary auto-scroll effect and all
    // further pagination for the rest of the session.
    const settle = () => {
      if (loadTokenRef.current !== token || !prependPendingRef.current) return;
      // If the load DID render as in-flight, the guaranteed `loadingEarlier`
      // false-edge commit owns the release (it lands with the prepended DOM);
      // releasing here would race that commit.
      if (sawLoadingRef.current) return;
      releasePendingPrepend();
    };
    // `Promise.resolve` normalizes a `void`-returning parent too, so a silent
    // no-op still settles (on the next microtask) instead of wedging.
    Promise.resolve(onLoadEarlier()).then(settle, settle);
  }, [hasMore, loadingEarlier, onLoadEarlier, releasePendingPrepend]);

  // The scroll listener is registered ONCE (empty deps, passive) — read the
  // current trigger through a ref instead of re-attaching on every prop change.
  const startLoadEarlierRef = useRef(startLoadEarlier);
  useEffect(() => {
    startLoadEarlierRef.current = startLoadEarlier;
  }, [startLoadEarlier]);

  // Track near-bottom state from real user scrolling. Recomputes `distance`
  // fresh on every `scroll` event rather than trusting a cached flag from
  // elsewhere — same rationale as the ResizeObserver path below. The same
  // listener also drives the near-TOP auto-load of the previous keyset page.
  useEffect(() => {
    const container = listRef.current?.parentElement;
    if (!container) return;
    const onScroll = () => {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      const near = distance < 80;
      applyAtBottom(near);
      if (container.scrollTop < NEAR_TOP_PX) startLoadEarlierRef.current();
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [applyAtBottom]);

  // MUST be useLayoutEffect, not useEffect: this needs to read/write layout
  // (scrollTop) before the browser paints the just-added content, so the
  // user never sees a frame at the old scroll position for content that's
  // about to be snapped to bottom.
  //
  // Guards on `atBottomRef.current` (captured from the LAST scroll event,
  // i.e. before this render's DOM mutation) rather than a fresh post-render
  // `distance` measurement: a single render that appends a lot of height (a
  // large tool card, a batched token flush) could otherwise read distance
  // >= 80 even though the user was following along right up to that append,
  // silently dropping them out of follow-mode mid-stream. `own send` (the
  // user's own optimistic bubble appearing, i.e. `pending.length` growing)
  // always snaps regardless, so sending still feels immediate.
  useLayoutEffect(() => {
    const container = listRef.current?.parentElement;
    const ownSend = pending.length > prevPendingLenRef.current;
    prevPendingLenRef.current = pending.length;
    if (!container) {
      bottomRef.current?.scrollIntoView({ block: "end" });
      return;
    }
    // A render that lands a prepended "load earlier" page belongs to the
    // scroll-restore effect below, which is the sole writer of `scrollTop`
    // for it — snapping to the bottom here first would either fight that
    // restore or overshoot past it. `ownSend` still wins: the user pressing
    // send always jumps to their own message.
    if (!ownSend && prependPendingRef.current) return;
    if (ownSend || atBottomRef.current) {
      container.scrollTop = container.scrollHeight;
      // The scroll above doesn't fire a `scroll` event synchronously in every
      // environment (and even where it does, staying pinned at the bottom
      // should keep `atBottom` true regardless) — keep the tracked state in
      // sync so the jump-to-bottom button doesn't flash on for a frame.
      if (!atBottomRef.current) applyAtBottom(true);
    }
    // `turnActive` here so the WorkingIndicator's own appear/disappear (it
    // changes the feed's content height) re-triggers the scroll too.
  }, [items.length, pending.length, thinking, turnActive, applyAtBottom]);

  // Scroll anchoring for prepended history. Declared AFTER the primary effect
  // on purpose: layout effects run in declaration order, so this is the last
  // writer of `scrollTop` for a prepend commit.
  //
  // MUST be useLayoutEffect: the shift has to be applied before the browser
  // paints, otherwise the user sees one frame where the whole transcript has
  // jumped down by the height of the newly prepended page — the classic
  // infinite-scroll-upward jump.
  //
  // Runs on EVERY render (no dep array) because its other job is keeping
  // `prevScrollHeightRef` current; the restore itself is gated on a pending
  // load that has actually been observed in flight. The OTHER release path —
  // for a load that never renders as in-flight — is the settle callback in
  // `startLoadEarlier`, which calls the same `releasePendingPrepend`.
  useLayoutEffect(() => {
    const container = listRef.current?.parentElement;
    if (!container) return;
    if (loadingEarlier) {
      sawLoadingRef.current = true;
    } else if (prependPendingRef.current && sawLoadingRef.current) {
      releasePendingPrepend(); // re-captures `prevScrollHeightRef` itself
      return;
    } else if (prependPendingRef.current) {
      // A load is pending but this render is neither "in flight" nor its
      // release — i.e. a page may already have landed while the parent never
      // rendered `loadingEarlier === true`. Do NOT re-capture the height
      // here: that would erase the pre-prepend measurement the settle
      // callback is about to restore from.
      return;
    }
    prevScrollHeightRef.current = container.scrollHeight;
  });

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

  // Distinct loaded turns — the "load all" hatch warns once the window is large.
  const loadedTurns = useMemo(() => {
    const ids = new Set<string>();
    for (const ev of events) if (ev.turnId) ids.add(ev.turnId);
    return ids.size;
  }, [events]);

  return (
    <div ref={listRef} className="chat-message-list" role="log" aria-label="Conversation">
      {/* Older history is loaded AUTOMATICALLY on scrolling near the top (see
       *  the scroll listener above); this button is kept deliberately as a
       *  manual fallback, not as the primary path. The auto-trigger rides on
       *  `scroll` events, so it cannot fire in the two cases where there is
       *  nothing to scroll: a loaded window shorter than the viewport, and a
       *  container already pinned at scrollTop 0. It also doubles as the
       *  top-of-list loading affordance (reusing this file's existing
       *  "Loading…" convention) so an in-flight auto-load is visible.
       *  "Load entire history" stays manual-only — R2.5 escape hatch. */}
      {hasMore && onLoadEarlier ? (
        <div className="chat-load-earlier" aria-live="polite">
          <button
            type="button"
            className="chat-load-earlier__btn"
            onClick={startLoadEarlier}
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
            // A still-open thinking group renders NOTHING while the turn is
            // active: its live header is always just "Thinking", which the
            // trailing `WorkingIndicator`'s "Thinking •••" line already says.
            // Once `groupEvents` closes the group the block appears in place
            // (items never reorder) as "Thought for Xs", expandable to the
            // accumulated reasoning. The second half of the gate compares
            // against the CURRENTLY RUNNING turn, not the global `turnActive`
            // flag: a group whose events carry no `turnId` (imported/resumed
            // transcripts start with `currentTurnId: undefined`) can never be
            // closed by `closeOpenThinking`, so gating on "any turn is
            // active" hid such historical reasoning for the whole duration of
            // every unrelated later turn.
            //
            // A group that is BOTH empty and unclosable (no `endedTs` and no
            // text — e.g. a turnId-less imported event, or a turn whose last
            // persisted event is a thinking event because the session died
            // mid-turn) never gets an `endedTs` from `closeOpenThinking`, so
            // it would otherwise render forever as a bare, non-expandable,
            // live-looking "Thinking" label over permanently dead content.
            // There is nothing meaningful to show, so it renders nothing. A
            // NON-empty unclosable group still renders once the turn ends.
            node =
              (item.endedTs || !turnActive || item.turnId !== activeTurnId) &&
              (item.endedTs || item.text.trim().length > 0) ? (
              <ThinkingBlock
                key={key}
                text={item.text}
                startedTs={item.startedTs}
                endedTs={item.endedTs}
                hadToolCall={item.hadToolCall}
              />
            ) : null;
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
        return node;
      })}

      {pending.map((p) => (
        <div key={p.turnId} className="chat-pending">
          <TextMessage role="user" text={p.message} attachments={p.attachments} pending />
        </div>
      ))}

      {turnActive ? <WorkingIndicator label={workingLabel} /> : null}

      <div ref={bottomRef} />

      {/* Floating jump-to-bottom affordance — only needed once the scroll
       *  guard above can leave the user stranded above the live edge (Decision
       *  5). Its containing block resolves to `.chat-pane__viewport` (the
       *  non-scrolling wrapper around `.chat-pane__body`, see chat.css), so it
       *  neither scrolls away with the content it lives in nor overlaps the
       *  footer below the viewport. */}
      {!atBottom ? (
        <button
          type="button"
          className="chat-jump-to-bottom"
          aria-label="Jump to latest message"
          onClick={() => {
            const container = listRef.current?.parentElement;
            if (!container) return;
            container.scrollTop = container.scrollHeight;
            applyAtBottom(true);
          }}
        >
          ↓
        </button>
      ) : null}
    </div>
  );
}
