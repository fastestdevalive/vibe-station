import { useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import { MessageSquare, X } from "lucide-react";
import type { Attachment, Command, ReviewSummary } from "@/api/types";
import { useAttachmentDrafts } from "@/hooks/useAttachmentDrafts";
import { AttachmentChip } from "./AttachmentChip";
import { SkillEditor, type SkillEditorHandle } from "./SkillEditor";
import { useMentionConfig } from "@/components/mentions/useMentionConfig";

interface QueuedTurnEditorProps {
  api: ApiInstance;
  sessionId: string;
  /** The queued/forked turn's id — disambiguates the editor's Lexical
   *  namespace when more than one `QueuedTurnEditor` could be mounted at
   *  once (tray row + fork editor). Falls back to `sessionId` alone if omitted. */
  turnId?: string;
  /** Raw text to prefill (from the withdraw response) — the flat brace-token
   *  wire string (Decision 2). */
  initialText: string;
  /** Attachment records to prefill as chips. */
  initialAttachments: Attachment[];
  /** Save the edit → resubmit `{edited:true}` at the original queue index. */
  onSave: (message: string, attachments: Attachment[], keepReview?: boolean) => Promise<void> | void;
  /** Discard → resubmit `{edited:false}` (restore unchanged). */
  onDiscard: () => Promise<void> | void;
  /** Session's slash-command/skill catalog (`session:meta.commands`) — threaded
   *  from `QueuedTray.tsx`/`MessageList.tsx`, both mount sites of this editor. */
  commands?: Command[];
  /** Comments the held turn carries: shown as a chip the user keeps or detaches (detached ones return to the panel). */
  review?: ReviewSummary;
}

/**
 * Inline editor for a queued turn that has been withdrawn for editing
 * (queue-controls). Prefilled with the turn's raw text + attachments; Save
 * re-enqueues the edit, Discard/Escape restores it unchanged. Auto-discard is
 * bound to Escape / explicit Cancel ONLY — never raw editor blur, which would
 * race the Save click and lose the edit (A3).
 *
 * Mounted at TWO sites (`QueuedTray.tsx`, `MessageList.tsx`'s fork editor) —
 * shares `<SkillEditor>` with `Composer.tsx` (Phase 7B.4): the wire string,
 * chip node, and the Enter-never-bubbles keymap are identical; only the exit
 * actions (Save/Discard vs. Send/Stop) differ.
 */
export function QueuedTurnEditor({
  api,
  sessionId,
  turnId,
  initialText,
  initialAttachments,
  onSave,
  onDiscard,
  commands,
  review,
}: QueuedTurnEditorProps) {
  const mentions = useMentionConfig(api, sessionId);
  const [text, setText] = useState(initialText);
  const [hasContent, setHasContent] = useState(() => initialText.trim().length > 0);
  const { drafts, readyAttachments, error, uploadFiles, removeDraft } = useAttachmentDrafts(
    api,
    sessionId,
    initialAttachments,
  );
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<SkillEditorHandle | null>(null);

  // The turn's comments stay on it unless the user detaches them (then they go back to the panel on Save).
  const [keepReview, setKeepReview] = useState(true);
  const reviewKept = !!review && keepReview;
  const hasAnyContent = hasContent || readyAttachments.length > 0 || reviewKept;
  const canSave = !busy && hasAnyContent;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    try {
      const message = editorRef.current?.getText().trim() ?? text.trim();
      // `keepReview` is passed only when the user detached the chip, so every other save keeps its old call shape.
      if (review && !keepReview) await onSave(message, readyAttachments, false);
      else await onSave(message, readyAttachments);
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (busy) return;
    setBusy(true);
    try {
      await onDiscard();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`chat-queued-editor${dragOver ? " chat-queued-editor--dragover" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void uploadFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {review ? (
        <div className="chat-queued-editor__chips">
          <span className="comment-chip" data-testid="queued-review-chip">
            <MessageSquare size={12} className="comment-attach__icon" aria-hidden />
            <span>
              {keepReview
                ? `${review.count} ${review.count === 1 ? "comment" : "comments"} attached`
                : `${review.count} ${review.count === 1 ? "comment returns" : "comments return"} to the panel`}
            </span>
            <button
              type="button"
              className="comment-chip__detach"
              aria-label={keepReview ? "Detach comments" : "Keep comments"}
              onClick={() => setKeepReview((v) => !v)}
            >
              <span className="comment-chip__sep" aria-hidden>
                ·
              </span>
              {keepReview ? "Detach" : "Keep"}
              {keepReview ? <X size={10} aria-hidden /> : null}
            </button>
          </span>
        </div>
      ) : null}
      {drafts.length > 0 ? (
        <div className="chat-queued-editor__chips">
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

      <div className="chat-queued-editor__field">
        <SkillEditor
          ref={editorRef}
          editorKey={`${sessionId}-queued-edit-${turnId ?? "single"}`}
          initialText={initialText}
          commands={commands}
          mentions={mentions}
          ariaLabel="Edit queued message"
          className="chat-queued-editor__textarea"
          onChangeText={(next, content) => {
            setText(next);
            setHasContent(content);
          }}
          onSubmit={() => void save()}
          onEscape={() => void discard()}
        />
      </div>

      <div className="chat-queued-editor__actions">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="chat-composer__file-input"
          aria-label="Attach files"
          onChange={(e) => {
            void uploadFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="chat-queued-editor__attach"
          aria-label="Attach files"
          title="Attach files"
          onClick={() => fileInputRef.current?.click()}
        >
          📎
        </button>
        <button
          type="button"
          className="chat-queued-editor__discard btn btn--secondary"
          onClick={() => void discard()}
          disabled={busy}
        >
          Discard
        </button>
        <button
          type="button"
          className="chat-queued-editor__save btn btn--primary"
          onClick={() => void save()}
          disabled={!canSave}
        >
          Save
        </button>
      </div>
    </div>
  );
}
