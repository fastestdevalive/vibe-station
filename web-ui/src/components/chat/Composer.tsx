import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Attachment, Command } from "@/api/types";
import { useAttachmentDrafts } from "@/hooks/useAttachmentDrafts";
import { loadDraft, useComposerDraft } from "@/hooks/useComposerDraft";
import { migrateV1Draft } from "@/lib/skillInvocation";
import { AttachmentChip } from "./AttachmentChip";
import { SkillEditor, type SkillEditorHandle } from "./SkillEditor";

/** How long the Send button is held (disabled) at its position after OUR OWN
 *  send emptied the box while a turn is still running — see `justSent`. */
const SEND_SETTLE_MS = 700;

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
  /** Ref to the editor handle so callers can return focus here (e.g. Escape
   *  from the queued-message tray). */
  textareaRef?: React.RefObject<SkillEditorHandle | null>;
  /** Session's slash-command/skill catalog (`session:meta.commands`).
   *  `undefined` means the catalog hasn't loaded yet — `/` renders as plain
   *  text, no popover, no row (Requirement 11). */
  commands?: Command[];
}

/** Message composer: skill-aware editor + send/stop + drag-drop / picker attachments. */
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
  commands,
}: ComposerProps) {
  const commandNames = (commands ?? []).map((c) => c.name);

  // Salvaged text (from a failed queued-turn edit) wins over any stored
  // draft; otherwise seed from the persisted draft for this session,
  // migrated once from the v1 canonical form if needed (Phase 7B.7). `text`
  // is the flat brace-token wire string (Decision 2), not display text.
  const [text, setText] = useState(() => migrateV1Draft(initialText ?? loadDraft(sessionId), commandNames));
  const [hasContent, setHasContent] = useState(() => text.trim().length > 0);
  const draft = useComposerDraft(sessionId);

  const [argFocused, setArgFocused] = useState(false);

  const { drafts, readyAttachments, error, uploadFiles, removeDraft, reset } = useAttachmentDrafts(
    api,
    sessionId,
    initialAttachments,
  );
  const [dragOver, setDragOver] = useState(false);
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const internalEditorRef = useRef<SkillEditorHandle | null>(null);
  const setEditorRef = useCallback(
    (el: SkillEditorHandle | null) => {
      internalEditorRef.current = el;
      if (textareaRef) textareaRef.current = el;
    },
    [textareaRef],
  );

  const hasAnyContent = hasContent || readyAttachments.length > 0;
  const canSend = !disabled && !sending && hasAnyContent;
  const nothingTyped = !hasAnyContent;

  // A successful send CLEARS the box while the turn may still be busy —
  // hold the Send branch, disabled, for a short settle window after our own
  // send so the same screen position can't flip to Stop under the user's
  // still-descending click.
  const [justSent, setJustSent] = useState(false);
  useEffect(() => {
    if (!justSent) return;
    const id = window.setTimeout(() => setJustSent(false), SEND_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [justSent]);

  async function handleSend() {
    if (!canSend) return;
    const message = internalEditorRef.current?.getText().trim() ?? text.trim();
    const ids = readyAttachments.map((a) => a.id);
    setSending(true);
    try {
      await onSend(message, ids);
      internalEditorRef.current?.clear();
      setText("");
      setHasContent(false);
      draft.clear();
      reset();
      setJustSent(true);
    } finally {
      setSending(false);
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
        <div className="chat-composer__field">
          <SkillEditor
            ref={setEditorRef}
            editorKey={sessionId}
            initialText={text}
            commands={commands}
            disabled={disabled}
            ariaLabel="Message"
            placeholder="Type a message…"
            className="chat-composer__textarea"
            onChangeText={(next, content) => {
              setText(next);
              draft.save(next);
              setHasContent(content);
            }}
            onSubmit={() => void handleSend()}
            onArgFocusChange={setArgFocused}
          />
        </div>
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
          {busy && nothingTyped && !justSent ? (
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
        {argFocused ? (
          <>Enter or → exits to the message · Backspace removes an argument, then the skill · Ctrl+Enter sends</>
        ) : (
          <>
            <span aria-hidden>⤓</span> Drop files here · Enter / Ctrl+Enter to send · Shift+Enter or Alt+Enter for
            newline
          </>
        )}
      </div>
      {commands === undefined ? (
        // Requirement 11 / Decision "catalog-unloaded": no row, no popover —
        // "/" renders as plain text until the session's command catalog loads.
        <div className="chat-composer__hint chat-composer__hint--skills">
          Skills loading… “/” inserts plain text until the catalog is ready.
        </div>
      ) : null}
    </div>
  );
}
