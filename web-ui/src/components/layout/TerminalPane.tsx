import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useIsTouch } from "@/hooks/useIsTouch";
import { useSessionOutput } from "@/hooks/useSubscription";
import { attachTouchScroll } from "@/lib/terminal-touch-scroll";
import { attachPinchZoom } from "@/lib/pinchZoom";
import { attachMobileInputFix } from "@/lib/mobile-input-fix";
import { createInputDebugger, isInputDebugEnabled, type InputDebugger } from "@/lib/input-debug";
import { SpawningPlaceholder } from "./SpawningPlaceholder";
import { useThemeStore } from "@/hooks/useThemeStore";
import { themeById, defaultThemeId } from "@/theme/registry";

interface TerminalPaneProps {
  api: ApiInstance;
  /** The session this pane renders. The agent pane and terminal dock each pass
   *  their own active session so the two xterms stream independently. */
  sessionId: string | null;
  /** Full session record for the rendered session (used for useTmux). */
  session?: Session;
  /**
   * Optional channel-toggle affordance (json-mode-followups item 4). This pane
   * owns its placement: a top-right overlay while the terminal is live, but
   * rendered in normal flow directly below the "Session exited / Resume" banner
   * once the session exits — so the two never overlap. The agent pane passes it;
   * the terminal dock omits it.
   */
  channelToggle?: ReactNode;
  /**
   * Whether this pane may steal keyboard focus on mount. Defaults to `true`.
   * The agent pane sets it to `false` in canvas/workspace mode, where panes are
   * floating tiles the user navigates between and focus must never be yanked
   * onto a tile (navigation-focus-change).
   */
  focusOnMount?: boolean;
  /**
   * Whether this pane follows the app's theme's ANSI palette. Defaults to
   * `true` for the themed agent pane. The plain terminal dock/tile
   * (Ctrl/Cmd+Shift+Z and canvas "terminal:" tiles) passes `false` to keep
   * its original fixed colors — it's not part of the themed agent UI.
   *
   * This is caller-supplied rather than inferred from `session.type`
   * because the mount effect below fires as soon as `sessionId` is set,
   * which can be before the full `session` record (with `.type`) has
   * loaded — and `session` is intentionally NOT a dependency of that
   * effect (it must never remount an existing terminal), so a
   * session-derived value could get stuck stale at its first, possibly
   * incomplete, read.
   */
  themed?: boolean;
}

/**
 * Detect xterm.js's auto-responses to terminal capability queries so we don't
 * forward them as keystrokes. Patterns:
 *   - DA1 reply: ESC [ ? <params> c   (e.g. \e[?1;2c)
 *   - DA2 reply: ESC [ > <params> c   (e.g. \e[>0;276;0c)
 *   - DSR cursor position: ESC [ <row> ; <col> R
 *   - DSR status report:   ESC [ 0 n
 * Real user input never matches these (function keys, arrows, modifier
 * combos all encode differently), so this is safe to drop unconditionally.
 */
function isXtermAutoResponse(data: string): boolean {
  /* eslint-disable no-control-regex */
  return (
    /^\x1b\[\?[\d;]+c$/.test(data) ||
    /^\x1b\[>[\d;]+c$/.test(data) ||
    /^\x1b\[\d+;\d+R$/.test(data) ||
    /^\x1b\[0n$/.test(data)
  );
  /* eslint-enable no-control-regex */
}

function terminalThemeFromCssVars(themeId: string): ITheme {
  const entry = themeById[themeId] ?? themeById[defaultThemeId]!;
  const v = entry.cssVars;
  return {
    background:          v["--term-background"],
    foreground:          v["--term-foreground"],
    cursor:              v["--term-cursor"],
    cursorAccent:        v["--term-cursor-accent"],
    selectionBackground: v["--term-selection-bg"],
    black:               v["--term-black"],
    red:                 v["--term-red"],
    green:               v["--term-green"],
    yellow:              v["--term-yellow"],
    blue:                v["--term-blue"],
    magenta:             v["--term-magenta"],
    cyan:                v["--term-cyan"],
    white:               v["--term-white"],
    brightBlack:         v["--term-bright-black"],
    brightRed:           v["--term-bright-red"],
    brightGreen:         v["--term-bright-green"],
    brightYellow:        v["--term-bright-yellow"],
    brightBlue:          v["--term-bright-blue"],
    brightMagenta:       v["--term-bright-magenta"],
    brightCyan:          v["--term-bright-cyan"],
    brightWhite:         v["--term-bright-white"],
  };
}

/** Original fixed palette, used whenever a pane isn't (or shouldn't be) themed. */
const FIXED_TERMINAL_THEME: ITheme = { background: "#0f0f0f", foreground: "#e5e5e5" };

/**
 * `themed` is the caller's "this pane is eligible for theming" declaration
 * (true for the agent pane, false for the plain terminal dock/tile — see
 * `TerminalPaneProps.themed`). Eligible panes additionally respect the
 * user's "Theme agent terminals" appearance setting, read live off the
 * workspace store so toggling it applies without remounting the terminal.
 */
function resolveTerminalTheme(themed: boolean): ITheme {
  if (!themed || !useWorkspaceStore.getState().themeAgentTerminals) return FIXED_TERMINAL_THEME;
  return terminalThemeFromCssVars(useThemeStore.getState().themeId);
}

export function TerminalPane({ api, sessionId, session, channelToggle, focusOnMount = true, themed = true }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const prevActiveSessionRef = useRef<string | null>(null);

  // This pane is driven by the `sessionId` prop, not the global active session,
  // so the agent pane and terminal dock can each show a different session.
  const activeSessionId = sessionId;
  const activeSessionIdRef = useRef<string | null>(sessionId);
  activeSessionIdRef.current = sessionId;
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);
  const sessionAttachState = useWorkspaceStore((s) => s.sessionAttachState);
  const patchSessionState = useWorkspaceStore((s) => s.patchSessionState);
  const markSessionAttachPending = useWorkspaceStore((s) => s.markSessionAttachPending);
  const markSessionAttached = useWorkspaceStore((s) => s.markSessionAttached);
  const clearSessionAttach = useWorkspaceStore((s) => s.clearSessionAttach);
  const terminalFontScale = useWorkspaceStore((s) => s.terminalFontScale);
  const bumpTerminalFont = useWorkspaceStore((s) => s.bumpTerminalFont);

  const [atBottom, setAtBottom] = useState(true);
  const [resumePending, setResumePending] = useState(false);

  // `sessionStates` is the LIVE map (WS `session:state`/`session:exited`/
  // `session:resumed` + the REST overlay on every reconnect). It can legitimately
  // have no entry at all for a session this client only just learned about —
  // e.g. a draft promoted a moment ago whose `session:state` frame hasn't landed
  // yet (or was missed while the socket was reconnecting). Falling back to the
  // session record's own `state` is what every other status surface already does
  // (`LeftSidebar.tsx:1287`, `DashboardPanel.tsx:185`, `SubagentRow.tsx:114` —
  // all `sessionStates[id] ?? s.state`), and it is exactly why the sidebar could
  // show a freshly-started agent's status dot while THIS pane showed nothing:
  // with `lifecycleState` undefined, `mountTerminal` AND `showSpawningOverlay`
  // below are both false, so the pane renders an empty box — no xterm mounted at
  // all and no "Starting…" placeholder — until a full page reload repopulates
  // the map via `syncSessionsFromApi`.
  const lifecycleState = (activeSessionId ? sessionStates[activeSessionId] : undefined) ?? session?.state;
  // Never steal keyboard focus on a touch-primary device (the soft keyboard /
  // IME would pop up over the tile for no reason). Reactive to the device's
  // pointer capability; see `useIsTouch`.
  const isTouch = useIsTouch();
  const attach = activeSessionId ? sessionAttachState[activeSessionId] : undefined;

  const attachPending = attach === "pending";

  // Only show "Starting…/Reconnecting…" when the session is actually meant
  // to come up — i.e. it's spawning, or it's running and we're awaiting an
  // attach. For an exited session the open will never succeed (daemon
  // rejects it), so the pending flag would otherwise sit forever and stack
  // a misleading "Reconnecting…" on top of the Resume banner.
  const showSpawningOverlay =
    lifecycleState === "not_started" ||
    (attachPending && (lifecycleState === "working" || lifecycleState === "idle"));

  // `drafting` joins `not_started` as a "there is nothing to attach to yet"
  // state: a draft has no tmux pane / pty at all, and the composer is what's
  // rendered in the pane's place. Before the `?? session.state` fallback above
  // this was unreachable (the map simply had no entry for a draft), but with it
  // a tab-scoped draft would otherwise mount a live xterm and fire
  // `session:open` at the daemon for a session that cannot be opened — and it
  // would do so while this pane is still parked in PaneHostLayer's hidden
  // offscreen holder, so xterm would measure a 0x0 cell grid too.
  const mountTerminal =
    Boolean(activeSessionId) &&
    lifecycleState != null &&
    lifecycleState !== "not_started" &&
    lifecycleState !== "drafting";

  // "Mark as done" releases the session's runtime: the daemon kills the tmux
  // pane / pty child, so there is nothing left to attach to. Every open would
  // just cost a failed `tmux has-session` round-trip and a transient error
  // frame. The terminal still MOUNTS (so its existing scrollback stays
  // readable) — it simply never re-opens a stream until Resume.
  const paneReleased = lifecycleState === "done";
  // Read through a ref inside the mount effect: making it a dependency would
  // tear down and rebuild the whole xterm instance the moment a session is
  // marked done — exactly the remount churn the stable-tree-position rule
  // (web-ui AGENTS.md §7-41) exists to avoid.
  const paneReleasedRef = useRef(paneReleased);
  paneReleasedRef.current = paneReleased;

  const spawnReason = lifecycleState === "not_started" ? "spawning" : "reconnecting";

  const { sessionState } = useSessionOutput(api, activeSessionId);

  const enableCopyModeScroll = session?.useTmux !== false;

  useEffect(() => {
    const cur = activeSessionId;
    const prev = prevActiveSessionRef.current;
    prevActiveSessionRef.current = cur;
    if (prev && prev !== cur) clearSessionAttach(prev);
    if (cur) markSessionAttachPending(cur);
  }, [activeSessionId, clearSessionAttach, markSessionAttachPending]);

  useEffect(() => {
    return api.on("session:opened", (ev) => {
      if (
        ev.type === "session:opened" &&
        ev.sessionId === activeSessionIdRef.current
      ) {
        markSessionAttached(ev.sessionId);
      }
    });
  }, [api, markSessionAttached]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !mountTerminal || !activeSessionId) return undefined;

    let mounted = true;

    const initialScale = useWorkspaceStore.getState().terminalFontScale;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: Math.round(14 * initialScale),
      // JetBrains Mono is loaded from Google Fonts (tokens.css), which serves
      // only a limited per-family character subset — it doesn't cover every
      // Unicode symbol block a CLI's TUI may emit (e.g. Claude Code's ⎿
      // connector glyphs, box-drawing logo art, bullet/sparkle markers).
      // xterm falls back per-glyph within this list, so more named fonts
      // before the generic `monospace` keyword means more chances to land on
      // one the OS actually has with that glyph, instead of falling straight
      // to whatever `monospace` happens to resolve to. Matches (and extends)
      // the site's own --font-mono fallback chain (tokens.css).
      fontFamily:
        "JetBrains Mono, Fira Code, SF Mono, Cascadia Code, Noto Sans Mono, monospace",
      lineHeight: 1.2,
      scrollback: 10000,
      allowProposedApi: true,
      // On macOS the Option key is not a true Alt/Meta key by default — the OS
      // composes special characters (e.g. Option+P -> "π") before xterm.js can
      // encode it as an ESC-prefixed escape sequence. Without this, Alt/Option
      // shortcuts inside the PTY (e.g. Claude Code's Alt+P model selector)
      // never reach the CLI. No-op on non-Mac platforms.
      macOptionIsMeta: true,
      // Only the agent pane is eligible for the app theme's ANSI palette —
      // the standalone terminal dock (Ctrl/Cmd+Shift+Z) is a plain shell,
      // not part of the themed agent UI, and keeps its own fixed look
      // regardless of the "Theme agent terminals" setting below.
      theme: resolveTerminalTheme(themed),
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);

    // xterm's built-in width table (Unicode 6, "ambiguous width" characters
    // treated as narrow) disagrees with the PTY side's libc wcwidth() for
    // several codepoints CLIs commonly emit (arrows, box-drawing, technical
    // symbols like ⏵/❯) — tmux writes the character assuming one column,
    // xterm reads it as needing a second, and the phantom continuation cell
    // it inserts renders as a literal "_". Loading this addon and opting
    // into version 11 realigns xterm's table with the modern glibc one tmux
    // actually uses.
    term.loadAddon(new Unicode11Addon());
    if (term.unicode) {
      term.unicode.activeVersion = "11";
    }

    // Make http:// and https:// URLs clickable — opens in system browser (Tauri) or new tab (browser dev)
    term.loadAddon(new WebLinksAddon((_, url) => {
      const tauri = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
      if (/^https?:/.test(url) && typeof tauri !== 'undefined') {
        tauri.invoke('plugin:shell|open', { path: url, openWith: null }).catch(() => {
          window.open(url, '_blank', 'noopener,noreferrer');
        });
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    }));

    term.open(host);

    // Both the app theme itself and the "Theme agent terminals" setting can
    // change while this terminal stays mounted (this effect deliberately
    // never remounts on prop/setting changes — see the stable-tree-position
    // note below), so each subscription just recomputes and re-applies
    // through the same resolver rather than reasoning about the two
    // independently. Skipped entirely for non-agent panes (`themed` false),
    // which never theme regardless of the setting.
    const unsubTheme = themed
      ? useThemeStore.subscribe((state, prev) => {
          if (state.themeId !== prev.themeId) {
            term.options.theme = resolveTerminalTheme(themed);
          }
        })
      : undefined;
    const unsubThemeAgentTerminals = themed
      ? useWorkspaceStore.subscribe((state, prev) => {
          if (state.themeAgentTerminals !== prev.themeAgentTerminals) {
            term.options.theme = resolveTerminalTheme(themed);
          }
        })
      : undefined;

    const helperTextarea = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");

    // Mobile soft-keyboard fix. On Android the hidden textarea accumulates and
    // xterm's keyCode-229 diff re-sends the whole buffer / lets Gboard mangle
    // input. attachMobileInputFix forwards single chars on the 229 path only
    // (desktop physical keys fall through untouched — see mobile-input-fix.ts).
    // Belt-and-braces: turn off the IME features that drive autocorrect churn.
    if (helperTextarea) {
      helperTextarea.setAttribute("autocomplete", "off");
      helperTextarea.setAttribute("autocorrect", "off");
      helperTextarea.setAttribute("autocapitalize", "off");
      helperTextarea.setAttribute("spellcheck", "false");
    }
    const disposeInputFix = helperTextarea
      ? attachMobileInputFix(helperTextarea, (data) => void api.sendKeystroke(activeSessionId, data))
      : null;

    // Diagnostic logger (mobile double-text investigation). Enabled per-device
    // with ?debugInput=1; records the full input pipeline to the daemon log so a
    // live repro can be audited. No-op when disabled.
    let inputDebug: InputDebugger | null = null;
    if (isInputDebugEnabled()) {
      inputDebug = createInputDebugger(api, activeSessionId);
      inputDebug.attachTextarea(helperTextarea);
      inputDebug.log({ kind: "fix-config", hasTextarea: !!helperTextarea });
    }

    // Steal keyboard focus on mount only on a non-touch device and when this
    // pane is allowed to focus (`focusOnMount` — false in canvas mode). On a
    // touch device we never focus (the soft keyboard / IME would pop up over
    // the tile); in canvas mode we never focus (tiles are navigated by
    // clicking). The effect re-runs on activeSessionId change, so tab switches
    // refocus the new tab's terminal on desktop classic mode.
    if (focusOnMount && !isTouch) {
      term.focus();
    }
    term.attachCustomKeyEventHandler((domEvent) => {
      const mod = domEvent.ctrlKey || domEvent.metaKey;
      if (mod && !domEvent.shiftKey) {
        const k = domEvent.key.toLowerCase();
        // Let app-level shortcuts (useWorkspaceKeyboardShortcuts) handle these
        // instead of forwarding them to the PTY.
        if (k === "p" || k === "b" || k === "e" || domEvent.key === "\\" || domEvent.key === "/") {
          return false;
        }
      }
      if (mod && domEvent.shiftKey) {
        const k = domEvent.key.length === 1 ? domEvent.key.toUpperCase() : domEvent.key;
        if (k === "F" || k === "P" || k === "Z" || k === "G" || k === "M") {
          return false;
        }
      }
      return true;
    });

    setAtBottom(true);

    try {
      fit.fit();
    } catch {
      /* ignore */
    }

    // Subscribe to output BEFORE openSession so the daemon's first replay
    // chunk is captured. Write directly to the terminal — do NOT route
    // through React state. Identical consecutive chunks (e.g. shell's
    // "\b \b" echo for repeated backspaces) get dropped by React's state-
    // equality bail-out; same-tick chunks get coalesced to the last value.
    const offOutput = api.on("session:output", (ev) => {
      if (
        ev.type === "session:output" &&
        ev.sessionId === activeSessionId &&
        termRef.current
      ) {
        termRef.current.write(ev.chunk);
      }
    });

    // Delay openSession to the first ResizeObserver callback instead of
    // calling it synchronously here. On mobile, term.focus() (above) triggers
    // the soft keyboard (IME) which shrinks the layout viewport via
    // interactive-widget=resizes-content. The IME takes ~100-300 ms to appear;
    // the ResizeObserver fires within one frame (~16 ms). By deferring, the
    // session almost always opens with the full-height pre-IME dimensions, so
    // the initial tmux buffer replay arrives at the right size. If the IME was
    // already open at mount (e.g. switching agents while the keyboard was
    // visible), the early-growth guard in the ResizeObserver RAF will clear
    // xterm's scrollback before the first size increase so no stale replay
    // rows appear frozen at the top of the expanded viewport.
    //
    // Released sessions skip openSession entirely — Resume is what re-opens
    // them — so we initialise sessionOpened to true for that case.
    let sessionOpened = paneReleasedRef.current;
    let sessionOpenedAt = 0;

    const openSessionOnce = () => {
      if (sessionOpened || !mounted) return;
      sessionOpened = true;
      sessionOpenedAt = Date.now();
      markSessionAttachPending(activeSessionId);
      void api.openSession(activeSessionId, term.cols, term.rows);
    };

    // Safety fallback: the ResizeObserver fires for the initial observation
    // almost immediately, but guard against edge-case browser quirks.
    const openFallbackTimer = window.setTimeout(() => {
      if (!sessionOpened) {
        requestAnimationFrame(() => {
          try { fit.fit(); } catch { /* ignore */ }
          openSessionOnce();
        });
      }
    }, 300);

    // Mobile vertical-swipe scrolling. In normal buffer it scrolls xterm's
    // scrollback; in alternate buffer (vim/htop/tmux copy-mode) it sends
    // tmux prefix `[` to enter copy-mode then arrow keys. onScrollAway
    // flips the jump-to-latest button on, since xterm.onScroll won't fire
    // in alternate buffer (the viewport never moves).
    const cleanupTouchScroll = attachTouchScroll(term, (data) => {
      void api.sendKeystroke(activeSessionId, data);
    }, {
      onScrollAway: () => setAtBottom(false),
      enableCopyModeScroll,
    });

    // Two-finger pinch (touch) / trackpad pinch (ctrl+wheel) zoom, on the same
    // shared `terminalFontScale` the Aa −/+ buttons already drive. Attached
    // here (torn down/reattached alongside `term` on every session switch)
    // rather than in its own effect, since `host` — not `hostRef`, to match
    // `attachTouchScroll`'s own element-scoped attach right above — is only
    // in scope inside this effect.
    //
    // Known overlap: `attachTouchScroll` above tracks single-finger vertical
    // drags (scrollback / tmux copy-mode) via Pointer Events, and doesn't
    // check for a second finger — a genuine two-finger pinch can therefore
    // also nudge that gesture's tracked pointer. In practice a pinch's
    // finger-spreading motion reads as the "horizontal" case that gesture
    // already ignores, so this is a rare edge case, not a regression of
    // normal one-finger scroll.
    const cleanupPinchZoom = attachPinchZoom(host, (delta) => bumpTerminalFont(delta));

    const scrollSub = term.onScroll(() => {
      const b = term.buffer.active;
      setAtBottom(b.viewportY >= b.length - term.rows);
    });

    // Tracks the last time a confirmed IME-dismiss resize fired — height grew
    // without width changing. The ResizeObserver RAF checks this (< 500 ms) to
    // decide whether to clear scrollback. A generic window.resize on desktop
    // (almost always changes width) does NOT set this flag, so desktop users
    // resizing their browser window never accidentally lose scrollback history.
    let lastIMEResizeAt = 0;
    let prevInnerWidth = window.innerWidth;
    let prevInnerHeight = window.innerHeight;

    let roPendingRaf: number | null = null;
    const ro = new ResizeObserver(() => {
      if (roPendingRaf !== null) cancelAnimationFrame(roPendingRaf);
      roPendingRaf = requestAnimationFrame(() => {
        roPendingRaf = null;
        if (!mounted) return;
        try {
          const b = term.buffer.active;
          // Capture whether we're at the bottom BEFORE fit changes term.rows.
          // After fit() grows the terminal (e.g. IME dismissed, tools pane
          // toggled), xterm's internal ydisp can lag behind the new ybase,
          // making the viewport appear cut off from the top. scrollToBottom()
          // resets ydisp = ybase so the live tail is visible again.
          const wasAtBottom = b.viewportY >= b.length - term.rows;

          // Clear scrollback before a grow triggered by a window-resize event
          // (IME dismiss/appear on Android, device rotation). Panel drag grows
          // the host div without firing window.resize, so that path skips the
          // clear — the user may have scrolled back in xterm's scrollback for
          // that case. In tmux mode, xterm scrollback only contains daemon
          // replay, so clearing is always safe on window-resize-triggered grows;
          // tmux redraws from scratch on the PTY resize notification.
          const proposed = fit.proposeDimensions();
          if (
            sessionOpened &&
            proposed != null &&
            proposed.rows > term.rows &&
            Date.now() - lastIMEResizeAt < 500
          ) {
            term.clear();
          }

          fit.fit();

          if (!sessionOpened) {
            // First ResizeObserver fire after mount — open the session now
            // with correctly fitted (pre-IME) dimensions.
            openSessionOnce();
          }
          // Resize RPC is handled by term.onResize (fired synchronously by
          // fit.fit() above) — no explicit resizeSession call needed here.

          if (term.rows > 0) {
            if (wasAtBottom) term.scrollToBottom();
            // Force a full row redraw after any resize to clear stale canvas
            // pixels from the previous size (see Bug #2 comment in AGENTS.md).
            term.refresh(0, term.rows - 1);
          }
        } catch {
          /* ignore */
        }
      });
    });
    ro.observe(host);

    const handleWindowResize = () => {
      if (!mounted || !sessionOpened) return;
      try {
        const newWidth = window.innerWidth;
        const newHeight = window.innerHeight;
        const heightGrew = newHeight > prevInnerHeight;
        const widthUnchanged = newWidth === prevInnerWidth;
        prevInnerWidth = newWidth;
        prevInnerHeight = newHeight;
        // Only mark an IME resize when height grows without width changing —
        // the signature of Android IME dismiss (interactive-widget=resizes-content).
        // Desktop browser-window resizes almost always change width; rotation
        // changes both dimensions. Neither should clear the user's scrollback.
        if (heightGrew && widthUnchanged) {
          lastIMEResizeAt = Date.now();
        }
        const b = term.buffer.active;
        const wasAtBottom = b.viewportY >= b.length - term.rows;
        const proposed = fit.proposeDimensions();
        if (proposed != null && proposed.rows > term.rows && heightGrew && widthUnchanged) {
          term.clear();
        }
        fit.fit();
        // Resize RPC handled by term.onResize fired synchronously by fit.fit().
        if (term.rows > 0) {
          if (wasAtBottom) term.scrollToBottom();
          term.refresh(0, term.rows - 1);
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", handleWindowResize);

    const d = term.onData((data) => {
      // Filter out xterm.js's auto-responses to terminal capability queries.
      // tmux/agents periodically send DA1 (\e[c) and DA2 (\e[>c) to identify
      // the terminal; xterm answers via term.onData. If we forward those
      // answers to api.sendKeystroke, they land in the shell's stdin and
      // get echoed into the agent's input box (e.g. [?1;2c [>84;0;0c
      // appearing as if typed). On a noisy connection this also turns into
      // a tight loop because the agent's redraw retriggers the query.
      if (isXtermAutoResponse(data)) return;
      // Diagnostic: what xterm actually emitted. If a printable chunk shows up
      // here while the fix also sent the char, that's the double-text smoking gun.
      inputDebug?.log({ kind: "onData", chunk: data, chunkLen: data.length });
      void api.sendKeystroke(activeSessionId, data);
    });
    // term.onResize is the single source of truth for PTY resize RPCs.
    // fit.fit() fires this synchronously when dimensions change; explicit
    // callers (ResizeObserver, handleWindowResize, font-size effect) do NOT
    // also call api.resizeSession — this handler covers them all.
    const r = term.onResize(({ cols, rows }) => {
      if (sessionOpened) {
        void api.resizeSession(activeSessionId, cols, rows);
      }
    });

    return () => {
      mounted = false;
      window.clearTimeout(openFallbackTimer);
      disposeInputFix?.();
      inputDebug?.dispose();
      offOutput();
      d.dispose();
      r.dispose();
      scrollSub.dispose();
      ro.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      cleanupTouchScroll();
      cleanupPinchZoom();
      if (roPendingRaf !== null) cancelAnimationFrame(roPendingRaf);
      void api.closeSession(activeSessionId);
      unsubTheme?.();
      unsubThemeAgentTerminals?.();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // `focusOnMount`, `isTouch`, and `themed` are deliberately NOT dependencies:
    // they are mount-time decisions (false in canvas mode / on touch devices;
    // fixed per call site for `themed`). Adding any would tear down and
    // rebuild the whole xterm the moment it flips — exactly the remount churn
    // the stable-tree-position rule forbids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, enableCopyModeScroll, api, mountTerminal, markSessionAttachPending]);

  useEffect(() => {
    if (activeSessionId && sessionState) {
      patchSessionState(activeSessionId, sessionState);
    }
  }, [activeSessionId, patchSessionState, sessionState]);

  useEffect(() => {
    const term = termRef.current;
    if (!term?.options || !mountTerminal) return;
    term.options.fontSize = Math.round(14 * terminalFontScale);
    term.clearTextureAtlas?.();
    fitRef.current?.fit();
    if (activeSessionId) {
      void api.resizeSession(activeSessionId, term.cols, term.rows);
    }
  }, [terminalFontScale, activeSessionId, api, mountTerminal]);

  useEffect(() => {
    // Re-attach on reconnect ONLY — not on the initial connect. The big
    // terminal-init effect above already calls openSession when mountTerminal
    // becomes true, so firing again here on the first online transition is
    // a redundant second openSession on the same connection. Two opens =
    // two handleSessionOpen calls = a tmux-attach race that on browser
    // refresh leaves a stale TmuxOutputStream still emitting chunks
    // alongside the live one (visible as double-echoed keystrokes).
    let prev = api.getConnectionState();
    let everOnline = prev === "online";
    return api.subscribeConnection((s) => {
      if (
        s === "online" &&
        prev !== "online" &&
        everOnline &&
        activeSessionId &&
        termRef.current &&
        mountTerminal &&
        !paneReleasedRef.current
      ) {
        termRef.current.reset();
        markSessionAttachPending(activeSessionId);
        void api.openSession(activeSessionId, termRef.current.cols, termRef.current.rows);
      }
      if (s === "online") everOnline = true;
      prev = s;
    });
  }, [api, activeSessionId, mountTerminal, markSessionAttachPending]);

  useEffect(() => {
    setResumePending(false);
  }, [activeSessionId]);

  async function resume() {
    if (!activeSessionId || resumePending) return;
    setResumePending(true);
    try {
      await api.resumeSession(activeSessionId);
      patchSessionState(activeSessionId, "working");
      const term = termRef.current;
      if (term) {
        term.reset();
        markSessionAttachPending(activeSessionId);
        void api.openSession(activeSessionId, term.cols, term.rows);
      }
    } finally {
      setResumePending(false);
    }
  }

  // Same live-map-with-record-fallback resolution as `lifecycleState` above —
  // they must agree, or the banner and the mount condition can disagree about
  // whether the pane is dead.
  const state = lifecycleState;
  // `done` gets the same banner as `exited`: the daemon has killed the pane in
  // both cases and Resume is the same one-click recovery. Without this a
  // done session would render a frozen, dead terminal with no way back — the
  // daemon sends no exit frame when it kills the pane under an attached
  // client, so this store state is the ONLY signal the pane gets.
  const showBanner = state === "done" || state === "exited" || sessionState === "exited";
  // `done` is checked before the local `sessionState`, which the dying pty can
  // push to "exited" — the deliberate state must win over the side effect.
  const bannerMsg = state === "done" ? "Session marked done." : "Session exited.";

  return (
    <div className="terminal-pane-root">
      {showBanner ? (
        <>
          <div className="terminal-resume-banner">
            <span className="terminal-resume-banner__msg">{bannerMsg}</span>
            <span className="terminal-resume-banner__action">
              {resumePending ? (
                <span className="terminal-resume-busy" role="status" aria-live="polite" aria-label="Resuming session">
                  <span className="terminal-resume-busy__ring" aria-hidden />
                  <span className="terminal-resume-busy__label">Resuming…</span>
                </span>
              ) : (
                <button type="button" className="terminal-resume-banner__btn" onClick={() => void resume()}>
                  Resume
                </button>
              )}
            </span>
          </div>
          {/* Exited: render the channel toggle in normal flow BELOW the banner so
              it no longer overlaps the banner / Resume button. */}
          {channelToggle ? <div className="terminal-exited-toggle">{channelToggle}</div> : null}
        </>
      ) : (
        // Live: the toggle is the usual top-right overlay (its own absolute CSS).
        channelToggle
      )}
      {!atBottom && mountTerminal && !showSpawningOverlay ? (
        <button
          type="button"
          className="terminal-scroll-btn"
          onClick={() => {
            const term = termRef.current;
            if (term) {
              if (term.buffer.active.type === "normal") {
                // Normal buffer: scrollback exists in xterm — use its API.
                term.scrollToBottom();
              } else if (activeSessionId) {
                // Alternate buffer: the user is in tmux copy-mode (entered
                // by attachTouchScroll on swipe-away). Send 'q' to exit
                // copy-mode and return to the live tail. xterm has no
                // scrollback to scroll to here.
                void api.sendKeystroke(activeSessionId, "q");
              }
            }
            setAtBottom(true);
          }}
        >
          ↓
        </button>
      ) : null}

      <div className="terminal-pane-stack-inner">
        {showSpawningOverlay ? (
          <div className="terminal-spawning-layer">
            <SpawningPlaceholder reason={spawnReason} />
          </div>
        ) : null}

        {mountTerminal ? (
          <div
            className="terminal-wrap"
            style={{
              flex: 1,
              minHeight: 0,
              opacity: showSpawningOverlay ? 0 : 1,
              pointerEvents: showSpawningOverlay ? "none" : "auto",
            }}
          >
            <div ref={hostRef} className="terminal-host" />
            {lifecycleState === "waiting_for_human" && !showBanner ? (
              <div className="terminal-waiting-hint">Waiting for your input</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
