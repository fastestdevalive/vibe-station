import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ApiInstance } from "@/api";
import type { Attachment, Session } from "@/api/types";
import { useChat } from "@/hooks/useChat";
import { useWorkspaceStore } from "@/hooks/useStore";
import { MessageList } from "@/components/chat/MessageList";
import { QueuedTray, type QueuedTrayRow } from "@/components/chat/QueuedTray";
import { Composer } from "@/components/chat/Composer";
import { StatusBar } from "@/components/chat/StatusBar";

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
}

/**
 * JSON agent chat pane. Rendered *beside* a permanently-mounted TerminalPane and
 * toggled by CSS visibility (never an if/else remount — Decision 14). Only opens
 * a chat when it's the visible pane for a `channel:"json"` session.
 */
export function ChatPane({ api, session, visible }: ChatPaneProps) {
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
  const thinking = meta?.turnState === "thinking";

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
            hiddenTurnIds={hiddenTurnIds}
            hasMore={hasMore}
            loadingEarlier={loadingEarlier}
            onLoadEarlier={() => void loadEarlier()}
            onLoadAll={() => void loadAll()}
            onRetry={handleRetry}
            api={api}
            {...(sessionId ? { sessionId } : {})}
            onForkTurn={(turnId, message, attachmentIds) => forkTurn(turnId, message, attachmentIds)}
          />
        )}
      </div>
      <div className="chat-pane__footer">
        <StatusBar
          meta={meta}
          queueDepth={trayRows.length}
          onStop={() => void stop()}
          api={api}
          {...(sessionId ? { sessionId } : {})}
        />
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
            onStop={() => void stop()}
            {...(salvage ? { initialText: salvage.text, initialAttachments: salvage.attachments } : {})}
          />
        ) : null}
      </div>
    </div>
  );
}
