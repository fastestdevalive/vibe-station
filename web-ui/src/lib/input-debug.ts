/**
 * Diagnostic terminal-input logger (mobile double-text investigation).
 *
 * Captures the full keystroke pipeline on the device and ships it to the daemon
 * over the WS (the phone's browser console is unreachable). For every key it
 * records keydown / composition* / beforeinput / input (with inputType, data,
 * isComposing, and the hidden textarea's value+selection) and what xterm
 * finally emitted via onData. The daemon writes these — interleaved with the
 * bytes it actually received — to <data-dir>/input-debug.log so a maintainer
 * can audit a live repro.
 *
 * OFF by default. Enable on mobile by opening the app with `?debugInput=1`
 * (persisted to localStorage); disable with `?debugInput=0`. No console access
 * needed. Remove this module once the bug is fixed.
 */

interface DebugSink {
  sendDebug?: (entries: Record<string, unknown>[]) => void | Promise<void>;
}

const STORAGE_KEY = "debugTerminalInput";

/** True if input debugging is enabled. Honours a `?debugInput=1|0` URL param
 *  (persisting it) so it can be toggled on a phone without a console. */
export function isInputDebugEnabled(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get("debugInput");
    if (q === "1") localStorage.setItem(STORAGE_KEY, "1");
    else if (q === "0") localStorage.setItem(STORAGE_KEY, "0");
    // Default OFF (opt-in). Enable per-browser with ?debugInput=1 to capture a
    // recurrence; this gates both the input logging and the daemon-side terminal
    // diagnostics (sizes, stream create/detach, live tmux-attach count).
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export interface InputDebugger {
  log: (entry: Record<string, unknown>) => void;
  attachTextarea: (el: HTMLTextAreaElement | null) => void;
  dispose: () => void;
}

export function createInputDebugger(api: DebugSink, sessionId: string): InputDebugger {
  let buf: Record<string, unknown>[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;
  let textarea: HTMLTextAreaElement | null = null;
  const listeners: Array<[string, EventListener]> = [];

  const flush = () => {
    if (buf.length === 0) return;
    const entries = buf;
    buf = [];
    try {
      void api.sendDebug?.(entries);
    } catch {
      /* best-effort */
    }
  };
  const schedule = () => {
    if (timer != null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 150);
  };
  const log = (entry: Record<string, unknown>) => {
    buf.push({ seq: seq++, t: Date.now(), sessionId, ...entry });
    if (buf.length >= 30) flush();
    else schedule();
  };

  // One-time environment line — the keyboard/OS matters for this bug.
  try {
    log({
      kind: "env",
      ua: navigator.userAgent,
      helperCount: document.querySelectorAll(".xterm-helper-textarea").length,
    });
  } catch {
    /* ignore */
  }

  const attachTextarea = (el: HTMLTextAreaElement | null) => {
    if (!el) {
      log({ kind: "attach", hasTextarea: false });
      return;
    }
    textarea = el;
    log({ kind: "attach", hasTextarea: true });

    // Capture phase so we observe the raw event first, before any other
    // listener could preventDefault it.
    const add = (type: string, fn: (e: Event) => void) => {
      el.addEventListener(type, fn, true);
      listeners.push([type, fn]);
    };
    const snap = () => ({
      value: el.value,
      valueLen: el.value.length,
      selStart: el.selectionStart,
      selEnd: el.selectionEnd,
    });
    add("keydown", (e) => {
      const k = e as KeyboardEvent;
      log({ kind: "keydown", key: k.key, code: k.code, keyCode: k.keyCode, isComposing: k.isComposing });
    });
    add("compositionstart", (e) =>
      log({ kind: "compositionstart", data: (e as CompositionEvent).data, ...snap() }),
    );
    add("compositionupdate", (e) =>
      log({ kind: "compositionupdate", data: (e as CompositionEvent).data, ...snap() }),
    );
    add("compositionend", (e) =>
      log({ kind: "compositionend", data: (e as CompositionEvent).data, ...snap() }),
    );
    add("beforeinput", (e) => {
      const i = e as InputEvent;
      log({ kind: "beforeinput", inputType: i.inputType, data: i.data, isComposing: i.isComposing, ...snap() });
    });
    add("input", (e) => {
      const i = e as InputEvent;
      log({ kind: "input", inputType: i.inputType, data: i.data, isComposing: i.isComposing, ...snap() });
    });
  };

  const dispose = () => {
    flush();
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if (textarea) {
      for (const [type, fn] of listeners) textarea.removeEventListener(type, fn, true);
    }
    listeners.length = 0;
    textarea = null;
  };

  return { log, attachTextarea, dispose };
}
