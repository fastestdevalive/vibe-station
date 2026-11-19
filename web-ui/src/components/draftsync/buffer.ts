/**
 * Per-scope offline buffer: the text this client typed but the server has not
 * acknowledged yet, tagged with the revision it was based on (Decision 6 — no
 * client-vs-server clock comparison, only revision equality).
 *
 * Every localStorage access is best-effort: private mode / quota simply lose the
 * buffer, never the draft (which lives in the editor until the tab closes).
 */

export interface DraftBuffer {
  text: string;
  baseRevision: number;
}

const BUFFER_PREFIX = "vst-draft-buffer:";
const keyFor = (scope: string) => `${BUFFER_PREFIX}${scope}`;

/** The buffered text for a scope, or null when absent/corrupt. */
export function readBuffer(scope: string): DraftBuffer | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(keyFor(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftBuffer> | null;
    if (typeof parsed?.text !== "string" || typeof parsed.baseRevision !== "number") return null;
    return { text: parsed.text, baseRevision: parsed.baseRevision };
  } catch {
    return null;
  }
}

export function writeBuffer(scope: string, text: string, baseRevision: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(keyFor(scope), JSON.stringify({ text, baseRevision } satisfies DraftBuffer));
  } catch {
    // storage unavailable — the editor still holds the text.
  }
}

export function clearBuffer(scope: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(keyFor(scope));
  } catch {
    // nothing to undo.
  }
}

/** Every scope with a stored buffer (Decision 6: a buffer may outlive the editor
 *  that wrote it, so a reconnect must flush it without a mounted binding). */
export function bufferedScopes(): string[] {
  if (typeof localStorage === "undefined") return [];
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(BUFFER_PREFIX) && key.length > BUFFER_PREFIX.length) {
        out.push(key.slice(BUFFER_PREFIX.length));
      }
    }
  } catch {
    return out;
  }
  return out;
}
