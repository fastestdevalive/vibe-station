import { useRef, useState } from "react";
import type { Attachment } from "@/api/types";
import { AttachmentChip } from "./AttachmentChip";

interface AttachmentPickerProps {
  /** Staged File objects (uploaded later, once a session exists). */
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}

/**
 * Stage files (raw `File` objects) BEFORE a session exists — used by the create
 * dialogs for JSON agents. Unlike the `Composer`, which uploads immediately
 * (it has a session id), this holds files in dialog state; they're uploaded
 * after the session is created (see `sendJsonFirstTurn`). Reuses `AttachmentChip`
 * for the 100gb-styled chip list.
 */
export function AttachmentPicker({ files, onChange, disabled }: AttachmentPickerProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function addFiles(added: File[]) {
    if (added.length === 0) return;
    onChange([...files, ...added]);
  }
  function removeAt(index: number) {
    onChange(files.filter((_, i) => i !== index));
  }

  return (
    <div
      className={`attachment-picker${dragOver ? " attachment-picker--dragover" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (disabled) return;
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {files.length > 0 ? (
        <div className="chat-composer__chips">
          {files.map((f, i) => (
            <AttachmentChip
              key={`${f.name}-${f.size}-${i}`}
              attachment={fileToAttachment(f, i)}
              onRemove={() => removeAt(i)}
            />
          ))}
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="chat-composer__file-input"
        aria-label="Attach files"
        disabled={disabled}
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <div className="attachment-picker__row">
        <button
          type="button"
          className="btn btn--secondary"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          📎 Attach files
        </button>
        <span className="attachment-picker__hint" aria-hidden>
          or drop files here
        </span>
      </div>
    </div>
  );
}

/** Present a staged File as an `Attachment` for the chip (no upload yet → blank path). */
function fileToAttachment(f: File, i: number): Attachment {
  return {
    id: `staged-${i}`,
    name: f.name,
    path: "",
    size: f.size,
    mime: f.type || "application/octet-stream",
  };
}
