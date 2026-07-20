import { useCallback, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Attachment } from "@/api/types";
import { ApiError } from "@/api/errors";

export interface DraftAttachment {
  attachment: Attachment;
  status?: "uploading" | "error";
}

export interface UseAttachmentDraftsResult {
  drafts: DraftAttachment[];
  /** Fully-uploaded (non-placeholder) attachments, safe to send. */
  readyAttachments: Attachment[];
  error: string | null;
  uploadFiles: (files: File[]) => Promise<void>;
  removeDraft: (id: string) => void;
  /** Replace all drafts (e.g. prefill the queued-turn editor). */
  setDrafts: (attachments: Attachment[]) => void;
  /** Clear drafts + error (e.g. after send). */
  reset: () => void;
}

/**
 * Attachment draft/upload state shared by the composer and the queued-turn
 * editor (queue-controls A12). Owns the uploading/error placeholder lifecycle so
 * both surfaces behave identically; drag-drop wiring stays in the components.
 */
export function useAttachmentDrafts(
  api: ApiInstance,
  sessionId: string,
  initial: Attachment[] = [],
): UseAttachmentDraftsResult {
  const [drafts, setDraftsState] = useState<DraftAttachment[]>(() =>
    initial.map((attachment) => ({ attachment })),
  );
  const [error, setError] = useState<string | null>(null);

  const readyAttachments = drafts.filter((d) => !d.status).map((d) => d.attachment);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setError(null);
      const placeholders: DraftAttachment[] = files.map((f, i) => ({
        status: "uploading",
        attachment: {
          id: `pending-${Date.now()}-${i}`,
          name: f.name,
          path: "",
          size: f.size,
          mime: f.type,
        },
      }));
      setDraftsState((prev) => [...prev, ...placeholders]);
      const placeholderIds = new Set(placeholders.map((p) => p.attachment.id));
      try {
        const { attachments } = await api.uploadAttachments(sessionId, files);
        setDraftsState((prev) => [
          ...prev.filter((d) => !placeholderIds.has(d.attachment.id)),
          ...attachments.map((a) => ({ attachment: a })),
        ]);
      } catch (err) {
        // Oversized (413) / other failure — mark placeholders errored but keep the
        // surface usable so the message is still sendable (CUJ 2).
        const msg =
          err instanceof ApiError
            ? err.status === 413
              ? "File too large."
              : err.message || "Upload failed."
            : "Upload failed.";
        setError(msg);
        setDraftsState((prev) =>
          prev.map((d) => (placeholderIds.has(d.attachment.id) ? { ...d, status: "error" } : d)),
        );
      }
    },
    [api, sessionId],
  );

  const removeDraft = useCallback((id: string) => {
    setDraftsState((prev) => prev.filter((d) => d.attachment.id !== id));
  }, []);

  const setDrafts = useCallback((attachments: Attachment[]) => {
    setError(null);
    setDraftsState(attachments.map((attachment) => ({ attachment })));
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setDraftsState([]);
  }, []);

  return { drafts, readyAttachments, error, uploadFiles, removeDraft, setDrafts, reset };
}
