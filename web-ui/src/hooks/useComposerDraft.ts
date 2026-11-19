import type { ApiInstance } from "@/api";
import { appendDraftText, useDraftText } from "@/components/draftsync";
import type { DraftBinding } from "@/components/draftsync";
import { readBuffer } from "@/components/draftsync/buffer";
import { engineFor } from "@/components/draftsync/engine";
import { legacyTextFor } from "@/components/draftsync/migrateLegacy";

/** Per-session composer draft: one server-owned scope per session (Decision 9).
 *  The hook is a thin wrapper — all state lives in the draftsync engine. */

const chatKey = (sessionId: string) => `vst-chat-draft-${sessionId}`;

/** Synchronous first-paint read: buffer → legacy key. Never writes. */
export function loadDraft(sessionId: string): string {
  return readBuffer(sessionId)?.text ?? legacyTextFor(sessionId);
}

export function useComposerDraft(
  api: ApiInstance,
  sessionId: string,
  onRemote: (text: string) => void,
): DraftBinding {
  return useDraftText(api, sessionId, { onRemote });
}

/** Fired (cancelable) by `appendComposerDraft`; detail `{ sessionId, text }`. */
export const COMPOSER_DRAFT_EXTERNAL_EVENT = "vst:composer-draft-external";

/**
 * Append text (draft grammar, unconverted) to a session's composer: on a new line when it is not empty. Used by
 * the review picker's row Attach, which hands its message to that agent's composer. A mounted composer for the
 * session claims the event (`preventDefault`) and inserts into its live editor, so file attachments and the
 * newest keystrokes survive (no remount, no stale read). With no composer mounted the engine appends to the
 * server-owned draft; only before the engine exists (tests / first paint) is the legacy key written.
 */
export function appendComposerDraft(api: ApiInstance, sessionId: string, text: string): void {
  if (text.trim().length === 0) return;
  if (typeof window !== "undefined") {
    const ev = new CustomEvent(COMPOSER_DRAFT_EXTERNAL_EVENT, { detail: { sessionId, text }, cancelable: true });
    window.dispatchEvent(ev);
    if (ev.defaultPrevented) return;
  }
  if (engineFor(api)) {
    appendDraftText(api, sessionId, text);
    return;
  }
  const existing = loadDraft(sessionId);
  const next = existing.trim().length > 0 ? `${existing}\n${text}` : text;
  try {
    localStorage.setItem(chatKey(sessionId), next);
  } catch {
    // storage unavailable: the message just isn't carried over.
  }
}
