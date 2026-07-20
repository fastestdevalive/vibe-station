/**
 * In-memory registry of uploaded attachments, keyed by session then upload id.
 *
 * The files themselves live durably under `sessionDataDir/uploads/<uid>/<name>`
 * (Decision 5) and are cleaned with the session data dir. This registry just
 * lets `POST /chat { attachmentIds }` resolve an id → its `Attachment` (path,
 * name, size, mime) without re-scanning disk. It is intentionally in-memory
 * (v1) — a draft attachment not yet referenced by a sent message is lost on
 * restart, which is acceptable.
 */

import type { Attachment } from "../types.js";

const bySession = new Map<string, Map<string, Attachment>>();

export function registerAttachment(sessionId: string, attachment: Attachment): void {
  let map = bySession.get(sessionId);
  if (!map) {
    map = new Map();
    bySession.set(sessionId, map);
  }
  map.set(attachment.id, attachment);
}

export function getAttachment(sessionId: string, uploadId: string): Attachment | undefined {
  return bySession.get(sessionId)?.get(uploadId);
}

/**
 * Remove one upload (json-mode-followups item 3, Decision 8) — used by the new
 * `DELETE /sessions/:id/attachments/:uploadId` route so a staged-but-unconsumed
 * terminal upload can be removed before it's injected. Returns the removed
 * record (undefined if it was already gone) so the caller can locate the
 * staged file / pending-uploads reference to unlink.
 */
export function removeAttachment(sessionId: string, uploadId: string): Attachment | undefined {
  const map = bySession.get(sessionId);
  const attachment = map?.get(uploadId);
  map?.delete(uploadId);
  return attachment;
}

export function clearSessionAttachments(sessionId: string): void {
  bySession.delete(sessionId);
}

/** Test helper. */
export function _clearAttachmentsForTest(): void {
  bySession.clear();
}
