import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useSessionOutput } from "@/hooks/useSubscription";
import { SpawningPlaceholder } from "./SpawningPlaceholder";

interface TerminalPaneProps {
  api: ApiInstance;
}

export function TerminalPane({ api }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastTouchY = useRef<number>(0);
  const prevActiveSessionRef = useRef<string | null>(null);

  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);
  const sessionAttachState = useWorkspaceStore((s) => s.sessionAttachState);
  const patchSessionState = useWorkspaceStore((s) => s.patchSessionState);
  const markSessionAttachPending = useWorkspaceStore((s) => s.markSessionAttachPending);
  const markSessionAttached = useWorkspaceStore((s) => s.markSessionAttached);
  const clearSessionAttach = useWorkspaceStore((s) => s.clearSessionAttach);
  const terminalFontScale = useWorkspaceStore((s) => s.terminalFontScale);

  const [atBottom, setAtBottom] = useState(true);
  const [resumePending, setResumePending] = useState(false);

  const lifecycleState = activeSessionId ? sessionStates[activeSessionId] : undefined;
  const attach = activeSessionId ? sessionAttachState[activeSessionId] : undefined;

  const attachPending = attach === "pending";

  const showSpawningOverlay = lifecycleState === "not_started" || attachPending;

  const mountTerminal =
    Boolean(activeSessionId) &&
    lifecycleState != null &&
    lifecycleState !== "not_started";

  const spawnReason = lifecycleState === "not_started" ? "spawning" : "reconnecting";

  const { lastChunk, sessionState } = useSessionOutput(api, activeSessionId);

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
        ev.sessionId === useWorkspaceStore.getState().activeSessionId
      ) {
        markSessionAttached(ev.sessionId);
      }
    });
  }, [api, markSessionAttached]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !mountTerminal || !activeSessionId) return undefined;

    let mounted = true;
    let rafId: number | null = null;
    let settleTimerId: ReturnType<typeof setTimeout> | null = null;

    // mountTerminal flips false→true when a new session transitions out of
    // not_started; the host div is conditionally rendered, so each remount is
    // a fresh DOM node. xterm's open() is single-shot and binds term.element
    // to a specific host — if we reuse the previous Terminal instance, it
    // keeps writing to the now-detached old host and the new host stays blank.
    // Detect the mismatch and recreate.
    const existingTerm = termRef.current;
    if (existingTerm && existingTerm.element && existingTerm.element !== host) {
      existingTerm.dispose();
      termRef.current = null;
      fitRef.current = null;
    }

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

    term.reset();
    setAtBottom(true);
    const scrollSub = term.onScroll(() => {
      const b = term.buffer.active;
      setAtBottom(b.viewportY >= b.length - term.rows);
    });
    try {
      fit.fit();
    } catch {
      /* ignore */
    }
    term.clearTextureAtlas?.();
    try {
      term.refresh(0, term.rows - 1);
    } catch {
      /* ignore */
    }

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
          /* ignore */
        }
      });
    });
    ro.observe(host);

    const handleWindowResize = () => {
      if (!mounted) return;
      try {
        fit.fit();
        if (activeSessionId) {
          void api.resizeSession(activeSessionId, term.cols, term.rows);
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", handleWindowResize);

    const fontsReadyPromise: Promise<void> =
      typeof document !== "undefined" && document.fonts?.ready
        ? document.fonts.ready.then(() => undefined)
        : Promise.resolve();

    void fontsReadyPromise.then(() => {
      if (!mounted) return;

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
          /* ignore */
        }
      };

      if (fontsListenerAttached) {
        fontsFace!.addEventListener("loadingdone", handleFontsLoadingDone);
      }

      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!mounted) return;
        try {
          termRef.current?.clearTextureAtlas?.();
          fit.fit();
        } catch {
          /* ignore */
        }

        settleTimerId = setTimeout(() => {
          settleTimerId = null;
          if (!mounted) return;
          try {
            fit.fit();
            term.refresh(0, term.rows - 1);
            if (activeSessionId) {
              markSessionAttachPending(activeSessionId);
              void api.openSession(activeSessionId, term.cols, term.rows);
            }
          } catch {
            /* ignore */
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
  }, [activeSessionId, api, mountTerminal, markSessionAttachPending]);

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
    let prev = api.getConnectionState();
    return api.subscribeConnection((s) => {
      if (s === "online" && prev !== "online" && activeSessionId && termRef.current && mountTerminal) {
        termRef.current.reset();
        markSessionAttachPending(activeSessionId);
        void api.openSession(activeSessionId, termRef.current.cols, termRef.current.rows);
      }
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

  const state = activeSessionId ? sessionStates[activeSessionId] : undefined;
  const showBanner = state === "exited" || sessionState === "exited";

  return (
    <div className="terminal-pane-root">
      {showBanner ? (
        <div className="terminal-resume-banner">
          <span className="terminal-resume-banner__msg">Session exited.</span>
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
      ) : null}
      {!atBottom && mountTerminal && !showSpawningOverlay ? (
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
          </div>
        ) : null}
      </div>
    </div>
  );
}
