import { useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Attachment, Command } from "@/api/types";
import { useAttachmentDrafts } from "@/hooks/useAttachmentDrafts";
import { AttachmentChip } from "./AttachmentChip";
import { SkillEditor, type SkillEditorHandle } from "./SkillEditor";

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
  onSave: (message: string, attachments: Attachment[]) => Promise<void> | void;
  /** Discard → resubmit `{edited:false}` (restore unchanged). */
  onDiscard: () => Promise<void> | void;
  /** Session's slash-command/skill catalog (`session:meta.commands`) — threaded
   *  from `QueuedTray.tsx`/`MessageList.tsx`, both mount sites of this editor. */
  commands?: Command[];
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
}: QueuedTurnEditorProps) {
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

  const hasAnyContent = hasContent || readyAttachments.length > 0;
  const canSave = !busy && hasAnyContent;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    try {
      const message = editorRef.current?.getText().trim() ?? text.trim();
      await onSave(message, readyAttachments);
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

      <div className="chat-queued-editor__field">
        <SkillEditor
          ref={editorRef}
          editorKey={`${sessionId}-queued-edit-${turnId ?? "single"}`}
          initialText={initialText}
          commands={commands}
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
