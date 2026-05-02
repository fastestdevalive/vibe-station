import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef } from "react";
import type { ApiInstance } from "@/api";
import type { WSEvent } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useSubscription } from "@/hooks/useSubscription";

interface TerminalPaneProps {
  api: ApiInstance;
}

export function TerminalPane({ api }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);
  const patchSessionState = useWorkspaceStore((s) => s.patchSessionState);
  const terminalFontScale = useWorkspaceStore((s) => s.terminalFontScale);

  const state = activeSessionId ? sessionStates[activeSessionId] : undefined;

  const onWs = useCallback(
    (ev: WSEvent) => {
      if (ev.type === "session:output" && ev.sessionId === activeSessionId && termRef.current) {
        termRef.current.write(ev.chunk);
      }
      if (ev.type === "session:state" && ev.sessionId === activeSessionId) {
        patchSessionState(ev.sessionId, ev.state);
      }
    },
    [activeSessionId, patchSessionState],
  );

  useSubscription(activeSessionId ? [activeSessionId] : [], onWs, (ids, cb) => api.subscribe(ids, cb));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const initialScale = useWorkspaceStore.getState().terminalFontScale;
    const term =
      termRef.current ??
      new Terminal({
        cursorBlink: true,
        fontSize: Math.round(14 * initialScale),
        fontFamily: "JetBrains Mono, monospace",
        theme: {
          background: "#0f0f0f",
          foreground: "#e5e5e5",
        },
      });
    termRef.current = term;

    const fit = fitRef.current ?? new FitAddon();
    fitRef.current = fit;
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

    const ro = new ResizeObserver(() => {
      fit.fit();
    });
    ro.observe(host);
    fit.fit();

    const d = term.onData((data) => {
      if (activeSessionId) {
        void api.sendInput(activeSessionId, { data });
      }
    });

    return () => {
      d.dispose();
      ro.disconnect();
    };
  }, [activeSessionId, api]);

  useEffect(() => {
    const term = termRef.current;
    if (!term?.options) return;
    term.options.fontSize = Math.round(14 * terminalFontScale);
    term.refresh(0, term.rows - 1);
    fitRef.current?.fit();
  }, [terminalFontScale]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || !activeSessionId) return;
    term.reset();
    term.writeln(`\x1b[90m— session ${activeSessionId}\x1b[0m`);
  }, [activeSessionId]);

  async function resume() {
    if (!activeSessionId) return;
    await api.resumeSession(activeSessionId);
  }

  const showBanner = state === "exited";

  return (
    <div className="pane-stack" style={{ flex: 1, minHeight: 0, background: "var(--bg-primary)" }}>
      {showBanner ? (
        <div className="terminal-resume-banner">
          Session exited.
          <button type="button" onClick={() => void resume()}>
            Resume
          </button>
        </div>
      ) : null}
      <div className="terminal-wrap">
        <div ref={hostRef} className="terminal-host" />
      </div>
    </div>
  );
}
