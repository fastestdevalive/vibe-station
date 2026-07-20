import { useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Attachment } from "@/api/types";
import { useAttachmentDrafts } from "@/hooks/useAttachmentDrafts";
import { AttachmentChip } from "./AttachmentChip";

interface QueuedTurnEditorProps {
  api: ApiInstance;
  sessionId: string;
  /** Raw text to prefill (from the withdraw response). */
  initialText: string;
  /** Attachment records to prefill as chips. */
  initialAttachments: Attachment[];
  /** Save the edit → resubmit `{edited:true}` at the original queue index. */
  onSave: (message: string, attachments: Attachment[]) => Promise<void> | void;
  /** Discard → resubmit `{edited:false}` (restore unchanged). */
  onDiscard: () => Promise<void> | void;
}

/**
 * Inline editor for a queued turn that has been withdrawn for editing
 * (queue-controls). Prefilled with the turn's raw text + attachments; Save
 * re-enqueues the edit, Discard/Escape restores it unchanged. Auto-discard is
 * bound to Escape / explicit Cancel ONLY — never raw textarea blur, which would
 * race the Save click and lose the edit (A3).
 */
export function QueuedTurnEditor({
  api,
  sessionId,
  initialText,
  initialAttachments,
  onSave,
  onDiscard,
}: QueuedTurnEditorProps) {
  const [text, setText] = useState(initialText);
  const { drafts, readyAttachments, error, uploadFiles, removeDraft } = useAttachmentDrafts(
    api,
    sessionId,
    initialAttachments,
  );
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // R6: a save clearing text with zero attachments is rejected.
  const canSave = !busy && (text.trim().length > 0 || readyAttachments.length > 0);

  async function save() {
    if (!canSave) return;
    setBusy(true);
    try {
      await onSave(text.trim(), readyAttachments);
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

      <textarea
        className="chat-queued-editor__textarea"
        aria-label="Edit queued message"
        rows={2}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            void discard();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
        }}
      />

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
