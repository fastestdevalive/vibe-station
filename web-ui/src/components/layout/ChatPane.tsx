import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ApiInstance } from "@/api";
import type { Attachment, Session } from "@/api/types";
import { useChat } from "@/hooks/useChat";
import { useWorkspaceStore } from "@/hooks/useStore";
import { MessageList } from "@/components/chat/MessageList";
import { QueuedTray, type QueuedTrayRow } from "@/components/chat/QueuedTray";
import { Composer } from "@/components/chat/Composer";
import { StatusBar, turnLabel } from "@/components/chat/StatusBar";
import { SubagentBanner } from "@/components/chat/SubagentBanner";

// Desktop bases for the --font-size-* tokens (tokens.css), scaled by the same
// PaneTools "Aa −/+" control that zooms TerminalPane's xterm font (14 * scale
// there). Chat's font-size rules read the shared --font-size-* custom
// properties, which are otherwise fixed, app-wide tokens — overriding them
// here (inline style) scopes the zoom to just this pane's subtree instead of
// resizing the whole app.
const CHAT_FONT_BASE_PX: Record<string, number> = {
  "--font-size-xs": 11,
  "--font-size-sm": 12,
  "--font-size-base": 14,
  "--font-size-lg": 16,
  "--font-size-xl": 18,
  "--font-size-2xl": 22,
  "--font-size-3xl": 28,
};

interface ChatPaneProps {
  api: ApiInstance;
  /** The JSON agent session this pane renders (undefined when the active agent
   *  is a TTY — the pane stays mounted but idle, hidden via `visible`). */
  session?: Session;
  /** Whether the pane is the visible one in its slot (CSS visibility toggle —
   *  Decision 14; the sibling TerminalPane stays permanently mounted). */
  visible: boolean;
  /** Called when the user requests navigation to a related session (e.g. a
   *  child task session or the parent session via SubagentBanner). Optional so
   *  existing callers don't need to change. */
  onNavigateToSession?: (sessionId: string) => void;
}

/**
 * JSON agent chat pane. Rendered *beside* a permanently-mounted TerminalPane and
 * toggled by CSS visibility (never an if/else remount — Decision 14). Only opens
 * a chat when it's the visible pane for a `channel:"json"` session.
 */
export function ChatPane({ api, session, visible, onNavigateToSession }: ChatPaneProps) {
  const isJson = session?.channel === "json";
  const sessionId = session?.id ?? null;
  const enabled = visible && isJson && !!sessionId;

  const terminalFontScale = useWorkspaceStore((s) => s.terminalFontScale);
  const chatFontVars = useMemo(() => {
    const vars: Record<string, string> = {};
    for (const [name, base] of Object.entries(CHAT_FONT_BASE_PX)) {
      vars[name] = `${Math.round(base * terminalFontScale)}px`;
    }
    return vars as CSSProperties;
  }, [terminalFontScale]);

  const {
    events,
    meta,
    pending,
    loading,
    hasMore,
    loadingEarlier,
    loadEarlier,
    loadAll,
    queuedTurnIds,
    editingTurnIds,
    editingDrafts,
    send,
    stop,
    cancelQueued,
    editQueued,
    saveEdit,
    discardEdit,
    sendNow,
    forkTurn,
  } = useChat(api, sessionId, enabled);

  // Salvaged draft from a failed queued-turn Save (A9): remounts the composer
  // (via `composerKey`) so its initial text/attachments apply.
  const [salvage, setSalvage] = useState<{ text: string; attachments: Attachment[] } | null>(null);
  const [composerKey, setComposerKey] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const turnActive = useMemo(() => {
    const s = meta?.turnState;
    return s === "thinking" || s === "responding" || s === "tool";
  }, [meta]);

  // Display-facing turn state, debounced (trailing ~250ms): the daemon
  // recomputes turnState per raw event, so it can oscillate thinking→tool→
  // thinking many times within one turn — committing every flip straight to
  // display state flickers the thinking-block/WorkingIndicator affordance.
  // `turnActive` above stays RAW/instant — Composer's busy/Stop gating must
  // never lag behind the real state.
  // Mirrored up from `MessageList` (which stays the owner of the scroll
  // measurement) purely so the footer `StatusBar` knows whether the in-feed
  // working indicator is visible. Defaults to `true`, matching MessageList's
  // own initial value, so no dots flash before the first scroll event.
  const [atBottom, setAtBottom] = useState(true);
  // `ChatPane` is NOT re-keyed per session — this one instance survives a pane
  // hide (`enabled` flips), a channel toggle and a session switch, while the
  // `MessageList` below fully unmounts/remounts across all three (the
  // loading/isEmpty/!enabled branches). Its own `atBottom` resets to `true` on
  // that remount, but this mirrored copy is only ever written by
  // `onAtBottomChange`, which by design doesn't fire until a real scroll
  // happens — so without this reset the footer could keep showing (or keep
  // hiding) the busy dots based on the PREVIOUS conversation's scroll
  // position, with no way to self-correct if the new transcript is shorter
  // than the viewport.
  useEffect(() => {
    setAtBottom(true);
  }, [sessionId, enabled]);
  const [displayTurnState, setDisplayTurnState] = useState(meta?.turnState);
  useEffect(() => {
    const id = setTimeout(() => setDisplayTurnState(meta?.turnState), 250);
    return () => clearTimeout(id);
  }, [meta?.turnState]);
  const thinking = displayTurnState === "thinking";
  // Label for the in-feed WorkingIndicator (Decision 8) — same `turnLabel`
  // StatusBar uses, fed the DEBOUNCED state so it's consistent with
  // `thinking`/the ThinkingBlock swap instead of flickering independently —
  // BUT only once the debounced value has actually caught up to a busy
  // state. On the very first idle→busy transition (or right after an
  // oscillation resets the debounce timer), `displayTurnState` can still
  // read "idle"/undefined for up to 250ms while `turnActive` (raw, driving
  // WorkingIndicator's mount) is already true — falling back to `turnLabel`
  // as-is would show "Ready •••" for that window. Falling back to the RAW
  // `meta?.turnState` here is safe: `turnActive` is only true when the raw
  // state is itself thinking/responding/tool, so the fallback is never
  // "Ready" while the indicator is actually mounted. Once the debounce
  // commits a busy value, this reads from `displayTurnState` again, so
  // further label oscillation is still smoothed as intended.
  const displayStateIsBusy =
    displayTurnState === "thinking" || displayTurnState === "responding" || displayTurnState === "tool";
  const workingLabel = turnLabel(displayStateIsBusy ? displayTurnState : meta?.turnState, meta?.queueDepth ?? 0);

  // Latest user text + attachments per turnId (last wins, mirroring the A7
  // edited-turn rule) + the set of turnIds that have a real `user` event.
  const userEvents = useMemo(() => {
    const map = new Map<string, { text: string; attachments?: Attachment[] }>();
    const ids = new Set<string>();
    for (const ev of events) {
      if (ev.kind === "user" && ev.turnId) {
        ids.add(ev.turnId);
        map.set(ev.turnId, { text: ev.text ?? "", attachments: ev.attachments });
      }
    }
    return { map, ids };
  }, [events]);

  // Queued + editing turns are shown in the tray, not the inline log.
  const hiddenTurnIds = useMemo(() => {
    const s = new Set<string>([...queuedTurnIds, ...editingTurnIds]);
    return s;
  }, [queuedTurnIds, editingTurnIds]);

  // Tray rows, oldest first: queued (FIFO) → editing (appended) → optimistic
  // queued-pending not yet reflected in meta/events.
  const trayRows = useMemo<QueuedTrayRow[]>(() => {
    const rows: QueuedTrayRow[] = [];
    const seen = new Set<string>();
    for (const turnId of queuedTurnIds) {
      if (seen.has(turnId)) continue;
      const info = userEvents.map.get(turnId);
      const fallback = pending.find((p) => p.turnId === turnId);
      const attachments = info?.attachments ?? fallback?.attachments;
      rows.push({
        turnId,
        text: info?.text ?? fallback?.message ?? "",
        status: "queued",
        ...(attachments && attachments.length ? { attachments } : {}),
      });
      seen.add(turnId);
    }
    for (const turnId of editingTurnIds) {
      if (seen.has(turnId)) continue;
      const info = userEvents.map.get(turnId);
      const draft = editingDrafts[turnId];
      rows.push({
        turnId,
        text: info?.text ?? "",
        status: "editing",
        ...(info?.attachments && info.attachments.length ? { attachments: info.attachments } : {}),
        ...(draft ? { draft } : {}),
      });
      seen.add(turnId);
    }
    for (const p of pending) {
      if (!p.queued || seen.has(p.turnId) || userEvents.ids.has(p.turnId)) continue;
      rows.push({
        turnId: p.turnId,
        text: p.message,
        status: "pending",
        ...(p.attachments.length ? { attachments: p.attachments } : {}),
      });
      seen.add(p.turnId);
    }
    return rows;
  }, [queuedTurnIds, editingTurnIds, editingDrafts, pending, userEvents]);

  // Only optimistic turns that AREN'T queued belong in the inline log; queued
  // optimistic bubbles are folded into the tray above.
  const pendingActive = useMemo(() => pending.filter((p) => !p.queued), [pending]);

  const onSalvage = useCallback((message: string, attachments: Attachment[]) => {
    setSalvage({ text: message, attachments });
    setComposerKey((k) => k + 1);
  }, []);

  const lastUserText = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.kind === "user") return events[i]!.text ?? "";
    }
    return pending.length > 0 ? pending[pending.length - 1]!.message : "";
  }, [events, pending]);

  const handleRetry = useCallback(() => {
    if (lastUserText) void send(lastUserText, []);
  }, [lastUserText, send]);

  const isEmpty = !loading && events.length === 0 && pending.length === 0;
  const archived = session?.archivedAt != null;

  // Keep the pane mounted even when hidden (Decision 14) — the terminal beside it
  // must never remount. `hidden` also stops the offscreen list from scrolling.
  if (!enabled) {
    return <div className="chat-pane chat-pane--hidden" aria-hidden hidden style={chatFontVars} />;
  }

  return (
    <div className="chat-pane" style={chatFontVars}>
      {/* Non-scrolling wrapper whose box is exactly the scroll VIEWPORT — it,
          not `.chat-pane`, is the containing block for the floating
          jump-to-bottom button, so the button clears the footer (queued tray +
          status bar + auto-growing composer) at any footer height instead of
          relying on a fixed offset that a tall footer overlaps. */}
      <div className="chat-pane__viewport">
        <div className="chat-pane__body">
          {loading ? (
            <div className="chat-pane__state">
              <span className="chat-spinner" aria-hidden /> Loading history…
            </div>
          ) : isEmpty ? (
            <div className="chat-pane__state chat-pane__empty">
              <div className="chat-pane__empty-icon" aria-hidden>💬</div>
              <div className="chat-pane__empty-title">Start chatting</div>
              <div className="chat-pane__empty-sub">with the agent</div>
            </div>
          ) : (
            <MessageList
              events={events}
              pending={pendingActive}
              turnActive={turnActive}
              thinking={thinking}
              workingLabel={workingLabel}
              hiddenTurnIds={hiddenTurnIds}
              hasMore={hasMore}
              loadingEarlier={loadingEarlier}
              onLoadEarlier={() => loadEarlier()}
              onLoadAll={() => void loadAll()}
              onRetry={handleRetry}
              api={api}
              {...(sessionId ? { sessionId } : {})}
              onForkTurn={(turnId, message, attachmentIds) => forkTurn(turnId, message, attachmentIds)}
              onAtBottomChange={setAtBottom}
              {...(meta?.cwd ? { cwd: meta.cwd } : {})}
              {...(onNavigateToSession ? { onNavigateToSession } : {})}
            />
          )}
        </div>
      </div>
      <div className="chat-pane__footer">
        {sessionId ? (
          <QueuedTray
            api={api}
            sessionId={sessionId}
            rows={trayRows}
            onEdit={(turnId) => void editQueued(turnId)}
            onSendNow={(turnId) => void sendNow(turnId)}
            onCancel={(turnId) => void cancelQueued(turnId)}
            onSave={(turnId, message, attachmentIds) => saveEdit(turnId, message, attachmentIds)}
            onDiscard={(turnId) => void discardEdit(turnId)}
            onSalvage={onSalvage}
            focusComposer={() => composerRef.current?.focus()}
          />
        ) : null}
        <StatusBar
          meta={meta}
          queueDepth={trayRows.length}
          atBottom={atBottom}
          onStop={() => void stop()}
          api={api}
          {...(sessionId ? { sessionId } : {})}
        />
        {session?.spawnedFrom ? (
          <SubagentBanner parentSessionId={session.spawnedFrom} onNavigate={onNavigateToSession} />
        ) : null}
        {sessionId && archived ? (
          // Decision 4 / CUJ 3: an archived session is read-only in place — no
          // new turns can be sent. Exact copy from the original F5 mockup.
          <div className="chat-composer chat-composer--archived" role="status">
            This session has been archived. Start a new agent to continue.
          </div>
        ) : sessionId ? (
          <Composer
            key={`${sessionId}:${composerKey}`}
            api={api}
            sessionId={sessionId}
            textareaRef={composerRef}
            onSend={(message, ids) => {
              setSalvage(null);
              return send(message, ids);
            }}
            busy={turnActive}
            canSteer={meta?.canSteer ?? false}
            onStop={() => void stop()}
            {...(salvage ? { initialText: salvage.text, initialAttachments: salvage.attachments } : {})}
          />
        ) : null}
      </div>
    </div>
  );
}
