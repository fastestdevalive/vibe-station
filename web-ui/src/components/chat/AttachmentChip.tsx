import type { Attachment } from "@/api/types";

function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface AttachmentChipProps {
  attachment: Attachment;
  /** When provided, renders a remove (✕) button (composer draft chips). */
  onRemove?: (id: string) => void;
  /** Upload/error status for a draft chip. */
  status?: "uploading" | "error";
}

export function AttachmentChip({ attachment, onRemove, status }: AttachmentChipProps) {
  const size = formatSize(attachment.size);
  return (
    <span className={`chat-attachment-chip${status === "error" ? " chat-attachment-chip--error" : ""}`}>
      <span className="chat-attachment-chip__icon" aria-hidden>📎</span>
      <span className="chat-attachment-chip__name" title={attachment.name}>
        {attachment.name}
      </span>
      {status === "uploading" ? (
        <span className="chat-attachment-chip__meta">uploading…</span>
      ) : status === "error" ? (
        <span className="chat-attachment-chip__meta">failed</span>
      ) : size ? (
        <span className="chat-attachment-chip__meta">{size}</span>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          className="chat-attachment-chip__remove"
          aria-label={`Remove ${attachment.name}`}
          onClick={() => onRemove(attachment.id)}
        >
          ✕
        </button>
      ) : null}
    </span>
  );
}
