import { useEffect, useRef } from "react";

/** Per-session composer draft persistence (localStorage, debounced writes).
 *  Key precedent: `vst-last-model-${cli}` (ModelPicker). */

const DRAFT_KEY = (sessionId: string) => `vst-chat-draft-${sessionId}`;
const SAVE_DEBOUNCE_MS = 400;

/** Read a stored draft for a session. Module fn so the Composer can seed its
 *  `useState` initializer synchronously. Any failure → "". */
export function loadDraft(sessionId: string): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(DRAFT_KEY(sessionId)) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(sessionId: string, text: string): void {
  try {
    if (text.trim().length === 0) {
      localStorage.removeItem(DRAFT_KEY(sessionId));
    } else {
      localStorage.setItem(DRAFT_KEY(sessionId), text);
    }
  } catch {
    // storage unavailable (private mode / quota) — drafts are best-effort.
  }
}

/** Debounced draft writer for one session. `save` coalesces keystrokes;
 *  `clear` drops the key on send; unmount flushes any pending write. */
export function useComposerDraft(sessionId: string) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ text: string } | null>(null);

  // Keep the latest sessionId available to the unmount flush without re-running
  // the cleanup effect on every keystroke.
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  function flush() {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current !== null) {
      writeDraft(sessionRef.current, pending.current.text);
      pending.current = null;
    }
  }

  function save(text: string) {
    pending.current = { text };
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (pending.current !== null) {
        writeDraft(sessionRef.current, pending.current.text);
        pending.current = null;
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function clear() {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = null;
    writeDraft(sessionRef.current, "");
  }

  // Flush a pending write synchronously on unmount (component-swap only; skip
  // `beforeunload` — a full reload with an unsaved keystroke is acceptable loss).
  useEffect(() => {
    return () => flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { save, clear };
}
