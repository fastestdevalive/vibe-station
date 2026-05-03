import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useSessionOutput } from "@/hooks/useSubscription";
import { attachTouchScroll } from "@/lib/terminal-touch-scroll";
import { SpawningPlaceholder } from "./SpawningPlaceholder";

interface TerminalPaneProps {
  api: ApiInstance;
  activeSession?: Session;
}

export function TerminalPane({ api, activeSession }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
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

  const { sessionState } = useSessionOutput(api, activeSessionId);

  const enableCopyModeScroll = activeSession?.useTmux !== false;

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

    const initialScale = useWorkspaceStore.getState().terminalFontScale;
    const term = new Terminal({
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

    const fit = new FitAddon();
    fitRef.current = fit;
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

    // Open session synchronously after fit. Daemon won't emit chunks
    // until openSession lands.
    markSessionAttachPending(activeSessionId);
    void api.openSession(activeSessionId, term.cols, term.rows);

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

    const scrollSub = term.onScroll(() => {
      const b = term.buffer.active;
      setAtBottom(b.viewportY >= b.length - term.rows);
    });

    let roPendingRaf: number | null = null;
    const ro = new ResizeObserver(() => {
      if (roPendingRaf !== null) cancelAnimationFrame(roPendingRaf);
      roPendingRaf = requestAnimationFrame(() => {
        roPendingRaf = null;
        if (!mounted) return;
        try {
          fit.fit();
          void api.resizeSession(activeSessionId, term.cols, term.rows);
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
        void api.resizeSession(activeSessionId, term.cols, term.rows);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", handleWindowResize);

    const d = term.onData((data) => {
      void api.sendKeystroke(activeSessionId, data);
    });
    const r = term.onResize(({ cols, rows }) => {
      void api.resizeSession(activeSessionId, cols, rows);
    });

    return () => {
      mounted = false;
      offOutput();
      d.dispose();
      r.dispose();
      scrollSub.dispose();
      ro.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      cleanupTouchScroll();
      if (roPendingRaf !== null) cancelAnimationFrame(roPendingRaf);
      void api.closeSession(activeSessionId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
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
          </div>
        ) : null}
      </div>
    </div>
  );
}
