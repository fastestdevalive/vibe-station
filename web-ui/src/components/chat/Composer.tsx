import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Attachment } from "@/api/types";
import { useAttachmentDrafts } from "@/hooks/useAttachmentDrafts";
import { loadDraft, useComposerDraft } from "@/hooks/useComposerDraft";
import { AttachmentChip } from "./AttachmentChip";

/** Grow the textarea up to this many lines of content, then scroll internally. */
const COMPOSER_MAX_GROW_LINES = 10;

/** How long the Send button is held (disabled) at its position after OUR OWN
 *  send emptied the box while a turn is still running — see `justSent`. */
const SEND_SETTLE_MS = 700;

/** Shift+Enter and Alt+Enter insert a newline. The OS/browser sometimes drops the
 *  modifier from the very next keydown when keys are released quickly, so a bare
 *  Enter arriving within this window after either combo is treated as another
 *  newline — a fast double-tap must never accidentally send the message. */
const NEWLINE_KEY_GUARD_MS = 500;

/** Resize `el` to fit its content, capped at `COMPOSER_MAX_GROW_LINES` worth
 *  of height (derived from the element's own resolved line-height/padding/
 *  border, not a guessed pixel constant, so it tracks the user's chat font
 *  size setting). Toggles internal scrolling once the cap is hit. */
function autosizeComposerTextarea(el: HTMLTextAreaElement) {
  const style = window.getComputedStyle(el);
  const lineHeight = parseFloat(style.lineHeight) || 20;
  const verticalExtra =
    (parseFloat(style.paddingTop) || 0) +
    (parseFloat(style.paddingBottom) || 0) +
    (parseFloat(style.borderTopWidth) || 0) +
    (parseFloat(style.borderBottomWidth) || 0);
  const maxHeight = lineHeight * COMPOSER_MAX_GROW_LINES + verticalExtra;
  el.style.height = "auto";
  const contentHeight = el.scrollHeight;
  el.style.height = `${Math.min(contentHeight, maxHeight)}px`;
  el.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}

interface ComposerProps {
  api: ApiInstance;
  sessionId: string;
  /** Enqueue a turn (message + resolved attachment ids). */
  onSend: (message: string, attachmentIds: string[]) => Promise<void> | void;
  /** A turn is active — show Stop instead of disabling. */
  busy?: boolean;
  onStop?: () => void;
  /** When true and busy, the send button label indicates steering instead of queuing. */
  canSteer?: boolean;
  /** Disable input entirely (e.g. session not ready). */
  disabled?: boolean;
  /** Prefill text (e.g. salvaged from a failed queued-turn edit, A9). */
  initialText?: string;
  /** Prefill attachment chips (salvaged from a failed edit, A9). */
  initialAttachments?: Attachment[];
  /** Ref to the textarea so callers can return focus here (e.g. Escape from the
   *  queued-message tray). */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}

/** Message composer: textarea + send/stop + drag-drop / picker attachments. */
export function Composer({
  api,
  sessionId,
  onSend,
  busy,
  onStop,
  canSteer,
  disabled,
  initialText,
  initialAttachments,
  textareaRef,
}: ComposerProps) {
  // Salvaged text (from a failed queued-turn edit) wins over any stored draft;
  // otherwise seed from the persisted draft for this session.
  const [text, setText] = useState(() => initialText ?? loadDraft(sessionId));
  const draft = useComposerDraft(sessionId);
  const { drafts, readyAttachments, error, uploadFiles, removeDraft, reset } = useAttachmentDrafts(
    api,
    sessionId,
    initialAttachments,
  );
  const [dragOver, setDragOver] = useState(false);
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Stable identity so React doesn't detach/reattach (null → el) on every
  // render — an inline arrow here would re-run the ref callback on every
  // keystroke, transiently nulling the caller's `textareaRef.current`.
  const setTextareaRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      internalTextareaRef.current = el;
      if (textareaRef) textareaRef.current = el;
    },
    [textareaRef],
  );

  // Re-run on every `text` change (typing, programmatic clear-on-send,
  // initial prefill) rather than only the onChange handler — one code path
  // covers grow AND shrink-back-down (3c) without duplicating the call site.
  // MUST be layout-effect, not a passive effect: a passive effect runs after
  // paint, so a keystroke that needs a taller box would paint one frame with
  // the OLD (shorter) height while `overflow-y: hidden` is already in CSS —
  // clipping the just-typed line/caret for that frame, every keystroke.
  useLayoutEffect(() => {
    if (internalTextareaRef.current) autosizeComposerTextarea(internalTextareaRef.current);
  }, [text]);

  // Split from `canSend`: whether the box HAS something to send (independent
  // of `sending`) decides the Stop-vs-Send BRANCH; `canSend` (which also
  // factors in `sending`/`disabled`) only decides whether the Send button is
  // enabled. Collapsing these into one flag was a bug (see `busy` branch
  // below): while a queued send is in flight, `sending` alone would make
  // `canSend` false, which — if used for branching too — flips the button to
  // Stop at the same screen position mid-send; a second/impatient click on
  // what a moment ago was "Send" would then abort the ORIGINAL turn instead.
  const hasContent = text.trim().length > 0 || readyAttachments.length > 0;
  const canSend = !disabled && !sending && hasContent;

  // The `hasContent` split above only deferred the swap hazard: a successful
  // send CLEARS the box while the turn is still busy, so `hasContent` drops to
  // false one tick later and the very same screen position turns into Stop —
  // an impatient second click would then abort the running turn. Approach
  // chosen (simplest that adds no persistent state): hold the Send branch,
  // disabled, for a short settle window after our own send. A real Stop is
  // still one moment (or one footer StatusBar click) away.
  const [justSent, setJustSent] = useState(false);
  useEffect(() => {
    if (!justSent) return;
    const id = window.setTimeout(() => setJustSent(false), SEND_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [justSent]);

  // Timestamp of the last Shift/Alt+Enter — see NEWLINE_KEY_GUARD_MS.
  const lastNewlineKeyRef = useRef<number>(0);

  async function handleSend() {
    if (!canSend) return;
    const message = text.trim();
    const ids = readyAttachments.map((a) => a.id);
    setSending(true);
    try {
      await onSend(message, ids);
      setText("");
      draft.clear();
      reset();
      setJustSent(true);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const isNewlineCombo = e.key === "Enter" && (e.shiftKey || e.altKey);
    if (isNewlineCombo) {
      lastNewlineKeyRef.current = Date.now();
      // Alt+Enter: browser doesn't insert a newline by default, do it manually.
      if (e.altKey && !e.shiftKey) {
        e.preventDefault();
        const ta = e.currentTarget;
        const start = ta.selectionStart ?? text.length;
        const end = ta.selectionEnd ?? text.length;
        const next = text.slice(0, start) + "\n" + text.slice(end);
        setText(next);
        draft.save(next);
        // Restore caret after React re-renders the controlled value.
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 1;
        });
      }
      return;
    }
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      void handleSend();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey) {
      if (Date.now() - lastNewlineKeyRef.current < NEWLINE_KEY_GUARD_MS) return;
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div
      className={`chat-composer${dragOver ? " chat-composer--dragover" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        void uploadFiles(files);
      }}
    >
      {drafts.length > 0 ? (
        <div className="chat-composer__chips">
          {drafts.map((d) => (
            <AttachmentChip
              key={d.attachment.id}
              attachment={d.attachment}
              status={d.status}
              onRemove={removeDraft}
            />
          ))}
        </div>
      ) : null}

      {error ? <div className="chat-composer__error">{error}</div> : null}

      <div className="chat-composer__row">
        <textarea
          ref={setTextareaRef}
          className="chat-composer__textarea"
          aria-label="Message"
          placeholder="Type a message…"
          rows={2}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            draft.save(e.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="chat-composer__actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="chat-composer__file-input"
            aria-label="Attach files"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              void uploadFiles(files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="chat-composer__attach"
            aria-label="Attach files"
            title="Attach files"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            📎
          </button>
          {/* Branch on `canSend`, not raw `busy` (Decision 9): a busy turn with
           *  text/an attachment ready should still show Send — clicking it
           *  enqueues a follow-up turn into the tray rather than sending
           *  immediately, which is a real, working action, not a no-op. Stop
           *  is reachable only in the one case where it's the sole useful
           *  action: busy AND nothing ready to send — and not during the
           *  `justSent` settle window, so our own clear-on-send can't swap
           *  Send for Stop under the user's cursor. */}
          {busy && !hasContent && !justSent ? (
            <button type="button" className="chat-composer__stop" onClick={onStop} aria-label="Stop turn">
              Stop
            </button>
          ) : (
            <button
              type="button"
              className={`chat-composer__send${busy && !canSteer ? " chat-composer__send--queue" : ""}`}
              aria-label={
                busy && canSteer
                  ? "Interrupts and steers the running turn"
                  : busy
                    ? "Send message (queues after current turn)"
                    : "Send message"
              }
              title={
                busy && canSteer
                  ? "Interrupts and steers the running turn"
                  : busy
                    ? "Sends after the current turn finishes"
                    : undefined
              }
              disabled={!canSend}
              onClick={() => void handleSend()}
            >
              ▶
            </button>
          )}
        </div>
      </div>
      <div className="chat-composer__hint">
        <span aria-hidden>⤓</span> Drop files here · Enter / Ctrl+Enter to send · Shift+Enter or Alt+Enter for newline
      </div>
    </div>
  );
}
