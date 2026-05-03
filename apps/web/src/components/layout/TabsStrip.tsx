import { Maximize2, Minimize2, Minus, Plus } from "lucide-react";
import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { NewTabDialog } from "@/components/dialogs/NewTabDialog";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";

interface TabsStripProps {
  api: ApiInstance;
  worktreeId: string | null;
}

export function TabsStrip({ api, worktreeId }: TabsStripProps) {
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const bumpTerminalFont = useWorkspaceStore((s) => s.bumpTerminalFont);
  const workspacePaneFullscreen = useWorkspaceStore((s) => s.workspacePaneFullscreen);
  const setWorkspacePaneFullscreen = useWorkspaceStore((s) => s.setWorkspacePaneFullscreen);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [closeTarget, setCloseTarget] = useState<Session | null>(null);

  useEffect(() => {
    if (!worktreeId) {
      setSessions([]);
      return;
    }
    void (async () => {
      const ss = await api.listSessions(worktreeId);
      setSessions(ss);
      useWorkspaceStore.getState().syncSessionsFromApi(ss);
      const main = ss.find((s) => s.slot === "m");
      const cur = useWorkspaceStore.getState().activeSessionId;
      const last = useWorkspaceStore.getState().lastSessionByWorktree[worktreeId];
      if (cur && ss.some((s) => s.id === cur)) {
        return;
      }
      const pick =
        (last && ss.some((s) => s.id === last) ? last : null) ??
        main?.id ??
        ss[0]?.id ??
        null;
      if (pick) setActiveSession(pick);
    })();
  }, [api, worktreeId, setActiveSession]);

  async function refreshTabs() {
    if (!worktreeId) return;
    const ss = await api.listSessions(worktreeId);
    setSessions(ss);
    useWorkspaceStore.getState().syncSessionsFromApi(ss);
  }

  return (
    <div className="tabs-strip" role="tablist" aria-label="Sessions">
      <div className="tabs-strip__scroll" ref={scrollRef}>
        {sessions.map((s) => {
          const active = s.id === activeSessionId;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-active={active}
              data-closeable={s.slot !== "m" ? "true" : undefined}
              className="tab"
              onClick={() => setActiveSession(s.id)}
              style={{ position: "relative", flexShrink: 0 }}
            >
              {active ? (
                <motion.span
                  layoutId="tab-indicator"
                  style={{
                    position: "absolute",
                    bottom: -1,
                    left: 0,
                    right: 0,
                    height: 2,
                    background: "var(--fg-muted)",
                    borderRadius: 1,
                  }}
                />
              ) : null}
              <span style={{ position: "relative", zIndex: 1 }}>{s.label}</span>
              {s.slot !== "m" ? (
                <span
                  role="button"
                  aria-label={`Close ${s.label}`}
                  className="tab__close"
                  onClick={(e) => { e.stopPropagation(); setCloseTarget(s); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setCloseTarget(s); } }}
                  tabIndex={-1}
                  style={{ position: "relative", zIndex: 1 }}
                >
                  ×
                </span>
              ) : null}
            </button>
          );
        })}
        <button
          type="button"
          className="tab tab--new"
          aria-label="New tab"
          onClick={() => setNewOpen(true)}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="tabs-strip__tools">
        <div className="tabs-strip__zoom" aria-label="Terminal zoom">
          <span className="tabs-strip__zoom-label">Aa</span>
          <button type="button" className="tab tab--icon" aria-label="Decrease terminal font" onClick={() => bumpTerminalFont(-0.05)}>
            <Minus size={11} />
          </button>
          <button type="button" className="tab tab--icon" aria-label="Increase terminal font" onClick={() => bumpTerminalFont(0.05)}>
            <Plus size={11} />
          </button>
        </div>
        <div className="tabs-strip__fs">
          <button
            type="button"
            className={`tab tab--icon${workspacePaneFullscreen === "terminal" ? " tab--fs-active" : ""}`}
            aria-label={workspacePaneFullscreen === "terminal" ? "Exit fullscreen terminal" : "Fullscreen terminal"}
            aria-pressed={workspacePaneFullscreen === "terminal"}
            title={workspacePaneFullscreen === "terminal" ? "Exit fullscreen terminal" : "Fullscreen terminal"}
            onClick={() =>
              setWorkspacePaneFullscreen(workspacePaneFullscreen === "terminal" ? null : "terminal")
            }
          >
            {workspacePaneFullscreen === "terminal" ? (
              <Minimize2 size={13} strokeWidth={2} aria-hidden />
            ) : (
              <Maximize2 size={13} strokeWidth={2} aria-hidden />
            )}
          </button>
        </div>
      </div>

      <NewTabDialog
        open={newOpen}
        api={api}
        worktreeId={worktreeId ?? ""}
        onClose={() => setNewOpen(false)}
        onCreated={() => void refreshTabs()}
      />

      <ConfirmDialog
        open={!!closeTarget}
        title="Close tab"
        message="Close this session?"
        confirmLabel="Close"
        onCancel={() => setCloseTarget(null)}
        onConfirm={() => {
          if (closeTarget) void api.deleteSession(closeTarget.id).then(() => void refreshTabs());
          setCloseTarget(null);
        }}
      />
    </div>
  );
}
