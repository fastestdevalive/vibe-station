/**
 * Touch scroll support for xterm.js terminals.
 *
 * Provides native-feeling vertical swipe scrolling on mobile devices. What a
 * swipe does is decided per-gesture, because the content to scroll lives in
 * different places depending on what the running program does with the terminal:
 * - Normal buffer (shell, Cursor, plain output): terminal.scrollLines() — the
 *   content is in xterm's scrollback.
 * - Alternate buffer + app has mouse tracking on (Claude fullscreen, vim with
 *   mouse=a): emit SGR mouse-WHEEL events — the app owns its viewport and has no
 *   scrollback, but scrolls in response to wheel input (exactly like a desktop
 *   mouse wheel).
 * - Alternate buffer + no mouse tracking: fall back to tmux copy-mode arrow keys.
 *
 * See docs/BROWSER-NOTES.md ("Terminal touch scrolling") for the full rationale.
 *
 * Usage:
 *   const cleanup = attachTouchScroll(terminal, (data) => sendKeystroke(id, data));
 *   // later: cleanup();
 */

interface TerminalLike {
  element: HTMLElement | undefined;
  buffer: { active: { type: string } };
  options: { fontSize?: number };
  cols?: number;
  rows?: number;
  /**
   * xterm's parsed terminal modes. `mouseTrackingMode` is 'none' when the app
   * has NOT requested mouse reporting, otherwise one of 'x10'|'vt200'|'drag'|
   * 'any'. We use it to decide whether a fullscreen app (alternate buffer) will
   * accept synthetic mouse-wheel events for scrolling.
   */
  modes?: { mouseTrackingMode?: string };
  scrollLines(amount: number): void;
}

export interface TouchScrollConfig {
  /** Pixels of movement before gesture direction is decided. Default: 8 */
  deadZone?: number;
  /** Ratio for vertical vs horizontal dominance. Default: 1.5 */
  verticalDominance?: number;
  /** Max lines scrolled per pointer event. Default: 6 */
  maxLinesPerEvent?: number;
  /** Speed multiplier for scroll amount. Default: 3 */
  speedMultiplier?: number;
  /** tmux prefix key (e.g. "\x02" for Ctrl-b, "\x01" for Ctrl-a). Default: "\x02" */
  tmuxPrefix?: string;
  /**
   * Called whenever the user swipes to view older content (scrolls away from
   * the live tail). Fires for both normal and alternate buffers. The viewport
   * `scroll` listener already covers normal-buffer scroll-away in xterm, but
   * in alternate buffer (tmux/vim) the viewport never scrolls, so this is the
   * only signal available.
   */
  onScrollAway?: () => void;
  /**
   * Called whenever the user swipes toward newer content. Lets the host
   * re-arm an idle timer that may auto-resume the live tail.
   */
  onScrollTowardLatest?: () => void;
  /**
   * When false, alternate-buffer swipes become a no-op instead of entering
   * tmux copy-mode. Set to false for direct-pty sessions (no tmux layer).
   * Default: true (preserves existing tmux copy-mode behavior).
   */
  enableCopyModeScroll?: boolean;
}

const DEFAULT_CONFIG: Required<Omit<TouchScrollConfig, "onScrollAway" | "onScrollTowardLatest" | "enableCopyModeScroll">> = {
  deadZone: 8,
  verticalDominance: 1.5,
  maxLinesPerEvent: 6,
  speedMultiplier: 3,
  tmuxPrefix: "\x02",
};

/** True when the running app has requested mouse reporting (so it will accept
 *  synthetic wheel events). */
function mouseTrackingActive(terminal: TerminalLike): boolean {
  const m = terminal.modes?.mouseTrackingMode;
  return m != null && m !== "none";
}

/** Map a viewport pixel position to a 1-based terminal cell (col,row), clamped
 *  to the grid. Used to address SGR mouse-wheel events at the swipe point. */
function cellAt(
  terminal: TerminalLike,
  root: HTMLElement,
  clientX: number,
  clientY: number,
): { col: number; row: number } {
  const cols = terminal.cols ?? 80;
  const rows = terminal.rows ?? 24;
  const rect = root.getBoundingClientRect();
  const cellW = rect.width / cols || 1;
  const cellH = rect.height / rows || 1;
  const col = Math.min(cols, Math.max(1, Math.floor((clientX - rect.left) / cellW) + 1));
  const row = Math.min(rows, Math.max(1, Math.floor((clientY - rect.top) / cellH) + 1));
  return { col, row };
}

/**
 * Attach touch scroll handlers to an xterm terminal.
 * `sendData` writes raw terminal input (used for tmux copy-mode in alternate buffer).
 * Returns a cleanup function to remove the listeners.
 */
export function attachTouchScroll(
  terminal: TerminalLike,
  sendData: (data: string) => void,
  config: TouchScrollConfig = {},
): () => void {
  const opts = { ...DEFAULT_CONFIG, ...config };
  const touchRoot = terminal.element;

  if (!touchRoot) {
    return () => {};
  }

  // touch-action:none on the outer element (and all descendants) prevents the
  // browser from taking over the gesture mid-swipe as a native pan. Without
  // this, xterm@5's canvas overlay combined with pan-y causes pointermove to
  // stop firing after the first event, giving the "scrolls once per swipe" bug.
  const prevTouchAction = touchRoot.style.touchAction;
  touchRoot.style.touchAction = "none";
  const viewport = touchRoot.querySelector<HTMLElement>(".xterm-viewport");
  if (viewport) {
    viewport.style.touchAction = "none";
  }

  let startX = 0;
  let startY = 0;
  let lastY = 0;
  let scrollMode: boolean | null = null; // null = undecided, true = scroll, false = not scroll
  let enteredCopyMode = false;

  const lineHeight = () => (terminal.options.fontSize ?? 13) * 1.2;

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    startX = e.clientX;
    startY = e.clientY;
    lastY = e.clientY;
    scrollMode = null;
    enteredCopyMode = false;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Decide gesture direction once movement exceeds dead zone
    if (scrollMode === null) {
      if (Math.max(absDx, absDy) < opts.deadZone) return;
      if (absDy < opts.verticalDominance * absDx) {
        scrollMode = false; // horizontal gesture, ignore
        return;
      }
      scrollMode = true;
      try {
        touchRoot.setPointerCapture(e.pointerId);
      } catch {
        // Element may be detached
      }
    }

    if (scrollMode !== true) return;

    e.preventDefault();

    let lineDelta = Math.round((e.clientY - lastY) / lineHeight());
    if (lineDelta > opts.maxLinesPerEvent) lineDelta = opts.maxLinesPerEvent;
    if (lineDelta < -opts.maxLinesPerEvent) lineDelta = -opts.maxLinesPerEvent;
    if (lineDelta === 0) return;

    lastY = e.clientY;

    const boostedDelta = lineDelta * opts.speedMultiplier;

    // Notify host of direction so it can manage followOutput / idle timers.
    // lineDelta > 0 = swipe down = view older content (scroll away from live tail).
    // lineDelta < 0 = swipe up   = view newer content (toward live tail).
    if (lineDelta > 0) {
      config.onScrollAway?.();
    } else {
      config.onScrollTowardLatest?.();
    }

    if (terminal.buffer.active.type === "normal") {
      // Natural touch-scroll direction: swipe finger DOWN (lineDelta > 0)
      // moves content down with the finger, revealing older scrollback above.
      // xterm's scrollLines(N) with positive N scrolls toward the BOTTOM of
      // the buffer (live tail / newer), so negate to match finger direction.
      terminal.scrollLines(-boostedDelta);
    } else if (mouseTrackingActive(terminal)) {
      // Alternate buffer + the app has mouse tracking on (e.g. Claude's
      // fullscreen, vim with `set mouse=a`). These apps own their viewport and
      // have NO terminal scrollback, so tmux copy-mode / scrollLines can't move
      // them — they sit at [0,0]. The app DOES scroll in response to mouse
      // WHEEL events though, so translate the swipe into SGR-encoded wheel
      // ticks: exactly what a desktop mouse wheel sends. tmux forwards these to
      // the app because it requested mouse reporting.
      const { col, row } = cellAt(terminal, touchRoot, startX, e.clientY);
      // swipe down (lineDelta > 0) reveals older content → wheel UP (btn 64);
      // swipe up reveals newer content → wheel DOWN (btn 65).
      const btn = lineDelta > 0 ? 64 : 65;
      // Each wheel tick already scrolls several lines in most apps, so use the
      // raw (un-boosted) line delta as the tick count to avoid over-scrolling.
      const ticks = Math.max(1, Math.abs(lineDelta));
      for (let i = 0; i < ticks; i++) {
        sendData(`\x1b[<${btn};${col};${row}M`);
      }
    } else if (config.enableCopyModeScroll !== false) {
      // Alternate buffer, NO mouse tracking — fall back to tmux copy-mode with
      // arrow keys. Only meaningful when there is a tmux layer (set false for
      // direct-pty sessions).
      if (!enteredCopyMode) {
        enteredCopyMode = true;
        sendData(opts.tmuxPrefix + "[");
      }
      // Invert: swipe up → scroll down (older), swipe down → scroll up (newer)
      const arrowKey = lineDelta > 0 ? "\x1b[A" : "\x1b[B";
      const count = Math.abs(boostedDelta);
      for (let i = 0; i < count; i++) {
        sendData(arrowKey);
      }
    }
    // else: alternate buffer + enableCopyModeScroll:false → no-op (direct-pty mode)
  };

  const onPointerEnd = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    try {
      if (touchRoot.hasPointerCapture(e.pointerId)) {
        touchRoot.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }
    scrollMode = null;
  };

  const captureOpts: AddEventListenerOptions = { capture: true };
  const moveCaptureOpts: AddEventListenerOptions = { capture: true, passive: false };

  touchRoot.addEventListener("pointerdown", onPointerDown, captureOpts);
  touchRoot.addEventListener("pointermove", onPointerMove, moveCaptureOpts);
  touchRoot.addEventListener("pointerup", onPointerEnd, captureOpts);
  touchRoot.addEventListener("pointercancel", onPointerEnd, captureOpts);

  return () => {
    touchRoot.removeEventListener("pointerdown", onPointerDown, captureOpts);
    touchRoot.removeEventListener("pointermove", onPointerMove, moveCaptureOpts);
    touchRoot.removeEventListener("pointerup", onPointerEnd, captureOpts);
    touchRoot.removeEventListener("pointercancel", onPointerEnd, captureOpts);
    touchRoot.style.touchAction = prevTouchAction;
  };
}
