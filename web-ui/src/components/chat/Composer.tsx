import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Attachment } from "@/api/types";
import { useAttachmentDrafts } from "@/hooks/useAttachmentDrafts";
import { loadDraft, useComposerDraft } from "@/hooks/useComposerDraft";
import { AttachmentChip } from "./AttachmentChip";

/** Grow the textarea up to this many lines of content, then scroll internally. */
const COMPOSER_MAX_GROW_LINES = 10;

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

  const canSend = !disabled && !sending && (text.trim().length > 0 || readyAttachments.length > 0);

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
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
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
          {busy ? (
            <button type="button" className="chat-composer__stop" onClick={onStop} aria-label="Stop turn">
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="chat-composer__send"
              aria-label="Send message"
              disabled={!canSend}
              onClick={() => void handleSend()}
            >
              ▶
            </button>
          )}
        </div>
      </div>
      <div className="chat-composer__hint">
        <span aria-hidden>⤓</span> Drop files here · Enter to send · Shift+Enter for newline
      </div>
    </div>
  );
}
