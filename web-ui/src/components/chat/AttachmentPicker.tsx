import { useRef, useState } from "react";
import type { Attachment } from "@/api/types";
import { AttachmentChip } from "./AttachmentChip";
import { ImagePlus } from "lucide-react";

interface AttachmentPickerProps {
  /** Staged File objects (uploaded later, once a session exists). */
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  /**
   * Compact variant for embedding in small overlays (e.g.
   * `TerminalAttachmentUpload`, which sits absolutely-positioned in the
   * terminal pane's corner) — smaller footprint, shorter copy, and no
   * "starting context" hint (this variant is used to attach files to an
   * already-running session, not at creation time).
   */
  compact?: boolean;
}

/**
 * Stage files (raw `File` objects) BEFORE a session exists — used by the create
 * dialogs for JSON agents. Unlike the `Composer`, which uploads immediately
 * (it has a session id), this holds files in dialog state; they're uploaded
 * after the session is created (see `sendJsonFirstTurn`). Reuses `AttachmentChip`
 * for the 100gb-styled chip list.
 */
export function AttachmentPicker({ files, onChange, disabled, compact }: AttachmentPickerProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function addFiles(added: File[]) {
    if (added.length === 0) return;
    onChange([...files, ...added]);
  }
  function removeAt(index: number) {
    onChange(files.filter((_, i) => i !== index));
  }

  function open() {
    if (!disabled) inputRef.current?.click();
  }

  return (
    <div
      className={`initial-artifacts${compact ? " initial-artifacts--compact" : ""}${dragOver ? " initial-artifacts--dragover" : ""}${disabled ? " initial-artifacts--disabled" : ""}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
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
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        aria-label="Attach files"
        disabled={disabled}
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      {files.length > 0 ? (
        <div
          className="chat-composer__chips"
          style={{ marginBottom: "var(--space-2)", width: "100%", display: "flex", flexWrap: "wrap", justifyItems: "center", justifyContent: "center", gap: "var(--space-2)" }}
          onClick={(e) => e.stopPropagation()}
        >
          {files.map((f, i) => (
            <AttachmentChip
              key={`${f.name}-${f.size}-${i}`}
              attachment={fileToAttachment(f, i)}
              onRemove={() => removeAt(i)}
            />
          ))}
        </div>
      ) : null}
      <ImagePlus size={compact ? 14 : 20} aria-hidden style={{ color: "var(--fg-muted)" }} />
      <div className="initial-artifacts__primary">
        {compact ? "Attach files" : "Drop images or files here, or click to browse"}
      </div>
      {compact ? null : (
        <div className="initial-artifacts__hint">Shared with the agent as starting context.</div>
      )}
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

