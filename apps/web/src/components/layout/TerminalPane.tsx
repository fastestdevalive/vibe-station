import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useSessionOutput } from "@/hooks/useSubscription";

interface TerminalPaneProps {
  api: ApiInstance;
}

export function TerminalPane({ api }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastTouchY = useRef<number>(0);

  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);
  const patchSessionState = useWorkspaceStore((s) => s.patchSessionState);
  const terminalFontScale = useWorkspaceStore((s) => s.terminalFontScale);

  const [atBottom, setAtBottom] = useState(true);

  const state = activeSessionId ? sessionStates[activeSessionId] : undefined;
  // useSessionOutput registers event listeners + WS subscription.
  // It does NOT call openSession — we do that below after fit.fit() so the
  // backend receives the actual terminal dimensions before replaying scrollback.
  const { lastChunk, sessionState } = useSessionOutput(api, activeSessionId);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    // mounted flag — guards async callbacks that run after a potential teardown
    let mounted = true;
    let rafId: number | null = null;
    let settleTimerId: ReturnType<typeof setTimeout> | null = null;

    const initialScale = useWorkspaceStore.getState().terminalFontScale;
    const term =
      termRef.current ??
      new Terminal({
        cursorBlink: true,
        fontSize: Math.round(14 * initialScale),
        fontFamily: "JetBrains Mono, monospace",
        lineHeight: 1.2,
        scrollback: 10000,
        allowProposedApi: true,
        theme: {
          background: "#0f0f0f",
          foreground: "#e5e5e5",
        },
      });
    termRef.current = term;

    const fit = fitRef.current ?? new FitAddon();
    fitRef.current = fit;
    // Phase 1: touch scroll handlers — re-attached every session switch
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches[0]) lastTouchY.current = e.touches[0].clientY;
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (!e.touches[0]) return;
      const delta = lastTouchY.current - e.touches[0].clientY;
      term.scrollLines(Math.round(delta / ((term.options.lineHeight ?? 1.2) * (term.options.fontSize ?? 14)) * 1.5));
      lastTouchY.current = e.touches[0].clientY;
      e.preventDefault();
    };
    host.addEventListener("touchstart", handleTouchStart, { passive: false });
    host.addEventListener("touchmove", handleTouchMove, { passive: false });

    if (!term.element) {
      term.loadAddon(fit);
      term.open(host);
      term.attachCustomKeyEventHandler((domEvent) => {
        const mod = domEvent.ctrlKey || domEvent.metaKey;
        if (mod && !domEvent.shiftKey && domEvent.key.toLowerCase() === "p") {
          return false;
        }
        if (mod && domEvent.shiftKey) {
          const k = domEvent.key.length === 1 ? domEvent.key.toUpperCase() : domEvent.key;
          if (k === "F" || k === "P" || k === "Z") {
            return false;
          }
        }
        return true;
      });
    }

    // Clear previous session output. Immediately re-fit and clear the glyph
    // atlas so the canvas is at correct dimensions before any content arrives —
    // reset() triggers a redraw, and the deferred RAF fit is too late to stop
    // that first bad paint.
    term.reset();
    setAtBottom(true);
    // Phase 2: scroll-to-bottom subscription
    const scrollSub = term.onScroll(() => {
      const b = term.buffer.active;
      setAtBottom(b.viewportY >= b.length - term.rows);
    });
    try { fit.fit(); } catch { /* ignore if not yet attached */ }
    term.clearTextureAtlas?.();
    console.log('[term] sync-fit', { host_w: host.clientWidth, host_h: host.clientHeight, cols: term.cols, rows: term.rows, session: activeSessionId });

    // RO tracks pending rAF so splitter-drag bursts coalesce to one per frame.
    let roPendingRaf: number | null = null;
    const ro = new ResizeObserver(() => {
      if (roPendingRaf !== null) cancelAnimationFrame(roPendingRaf);
      roPendingRaf = requestAnimationFrame(() => {
        roPendingRaf = null;
        if (!mounted) return;
        try {
          fit.fit();
          if (activeSessionId) {
            void api.resizeSession(activeSessionId, term.cols, term.rows);
          }
        } catch {
          // ignore fit errors during teardown
        }
      });
    });
    ro.observe(host);

    // window resize is a safety net for DPR/zoom changes that may not fire RO.
    const handleWindowResize = () => {
      if (!mounted) return;
      try {
        fit.fit();
        if (activeSessionId) {
          void api.resizeSession(activeSessionId, term.cols, term.rows);
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener("resize", handleWindowResize);

    // Fonts.ready gate: defer first open until the browser has loaded fonts so
    // xterm measures cell metrics against JetBrains Mono, not the fallback.
    // Feature-detect: jsdom does not implement document.fonts.
    const fontsReadyPromise: Promise<void> =
      typeof document !== "undefined" && document.fonts?.ready
        ? document.fonts.ready.then(() => undefined)
        : Promise.resolve();

    void fontsReadyPromise.then(() => {
      if (!mounted) return;

      // Attach loadingdone listener for late font-swap (font-display:swap).
      // Feature-detect: jsdom's document.fonts mock lacks addEventListener.
      const fontsFace = typeof document !== "undefined" ? document.fonts : undefined;
      const fontsListenerAttached =
        !!fontsFace && typeof fontsFace.addEventListener === "function";

      const handleFontsLoadingDone = () => {
        if (!mounted || !fitRef.current || !termRef.current) return;
        try {
          termRef.current.clearTextureAtlas?.();
          fitRef.current.fit();
          if (activeSessionId) {
            void api.resizeSession(activeSessionId, termRef.current.cols, termRef.current.rows);
          }
        } catch {
          // ignore
        }
      };

      if (fontsListenerAttached) {
        fontsFace!.addEventListener("loadingdone", handleFontsLoadingDone);
      }

      // Initial rAF fit — let panel layout settle one frame.
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!mounted) return;
        try {
          termRef.current?.clearTextureAtlas?.();
          fit.fit();
          console.log('[term] raf-fit', { host_w: host.clientWidth, host_h: host.clientHeight, cols: term.cols, rows: term.rows });
        } catch {
          // ignore
        }

        // Deferred-settle: react-resizable-panels sometimes finalises
        // flex-basis after the first rAF. 100ms gives it time to land.
        settleTimerId = setTimeout(() => {
          settleTimerId = null;
          if (!mounted) return;
          try {
            fit.fit();
            console.log('[term] settle-fit → openSession', { cols: term.cols, rows: term.rows, session: activeSessionId });
            if (activeSessionId) {
              void api.openSession(activeSessionId, term.cols, term.rows);
            }
          } catch {
            // ignore
          }
        }, 100);
      });

      return () => {
        if (fontsListenerAttached) {
          fontsFace!.removeEventListener("loadingdone", handleFontsLoadingDone);
        }
      };
    });

    const d = term.onData((data) => {
      if (activeSessionId) {
        void api.sendKeystroke(activeSessionId, data);
      }
    });
    // Keep onResize as a secondary path; we also always call resizeSession
    // explicitly after fit so col/row drift is avoided.
    const r = term.onResize(({ cols, rows }) => {
      if (activeSessionId) {
        void api.resizeSession(activeSessionId, cols, rows);
      }
    });

    return () => {
      mounted = false;
      d.dispose();
      r.dispose();
      scrollSub.dispose();
      ro.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      if (host) {
        host.removeEventListener("touchstart", handleTouchStart);
        host.removeEventListener("touchmove", handleTouchMove);
      }
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (settleTimerId !== null) clearTimeout(settleTimerId);
      if (roPendingRaf !== null) cancelAnimationFrame(roPendingRaf);
      if (activeSessionId) {
        void api.closeSession(activeSessionId);
      }
    };
  }, [activeSessionId, api]);

  useEffect(() => {
    if (activeSessionId && sessionState) {
      patchSessionState(activeSessionId, sessionState);
    }
  }, [activeSessionId, patchSessionState, sessionState]);

  useEffect(() => {
    if (lastChunk && termRef.current) {
      termRef.current.write(lastChunk);
    }
  }, [lastChunk]);

  // Fix 3: font-size effect — correct order, no pre-fit refresh(), plus
  // clearTextureAtlas() so stale atlas glyphs are dropped immediately.
  useEffect(() => {
    const term = termRef.current;
    if (!term?.options) return;
    term.options.fontSize = Math.round(14 * terminalFontScale);
    term.clearTextureAtlas?.();
    fitRef.current?.fit();
    if (activeSessionId) {
      void api.resizeSession(activeSessionId, term.cols, term.rows);
    }
  }, [terminalFontScale, activeSessionId, api]);

  // Re-open the active session when the daemon WS reconnects so scrollback
  // gets replayed at the current terminal dimensions.
  useEffect(() => {
    let prev = api.getConnectionState();
    return api.subscribeConnection((s) => {
      if (s === "online" && prev !== "online" && activeSessionId && termRef.current) {
        termRef.current.reset();
        void api.openSession(activeSessionId, termRef.current.cols, termRef.current.rows);
      }
      prev = s;
    });
  }, [api, activeSessionId]);

  async function resume() {
    if (!activeSessionId) return;
    await api.resumeSession(activeSessionId);
    // Daemon spawned a fresh tmux pane. Clear the exited marker in the
    // store, wipe stale scrollback, and re-attach the WS stream so output
    // from the new pane flows into this terminal. We must close first to
    // unregister the daemon-side stream that's still pointed at the dead pane.
    patchSessionState(activeSessionId, "working");
    const term = termRef.current;
    if (term) {
      term.reset();
      // Daemon's sessionOpen handler auto-detaches any stale stream pointing
      // at the dead pane, so this just attaches to the new one.
      void api.openSession(activeSessionId, term.cols, term.rows);
    }
  }

  const showBanner = state === "exited" || sessionState === "exited";

  return (
    <div className="pane-stack" style={{ flex: 1, minHeight: 0, background: "var(--bg-primary)", position: "relative" }}>
      {showBanner ? (
        <div className="terminal-resume-banner">
          Session exited.
          <button type="button" onClick={() => void resume()}>
            Resume
          </button>
        </div>
      ) : null}
      {!atBottom ? (
        <button
          type="button"
          className="terminal-scroll-btn"
          onClick={() => {
            termRef.current?.scrollToBottom();
            setAtBottom(true);
          }}
        >
          ↓
        </button>
      ) : null}
      <div className="terminal-wrap">
        <div ref={hostRef} className="terminal-host" />
      </div>
    </div>
  );
}
