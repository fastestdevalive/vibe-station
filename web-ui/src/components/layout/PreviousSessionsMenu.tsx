import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { History } from "lucide-react";
import type { Session } from "@/api/types";
import { resolveSupersededChain, listPredecessors } from "@/lib/sessionVisibility";
import { sessionLabel } from "@/lib/sessionLabel";
import { useEventTargets, usePortalRoot, useViewportWidth } from "@/context/DemoEnv";

function formatArchivedTime(v: string): string {
  const d = /^\d+$/.test(v) ? new Date(Number(v)) : new Date(v);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export interface PreviousSessionsMenuProps {
  activeSession: Session | null;
  sessions: Session[];
  onOpen: (id: string) => void;
}

export function PreviousSessionsMenu({
  activeSession,
  sessions,
  onOpen,
}: PreviousSessionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const portalRoot = usePortalRoot();
  const envWidth = useViewportWidth();
  const { doc } = useEventTargets();

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(ev: MouseEvent) {
      const t = ev.target as HTMLElement;
      if (t.closest("[data-previous-sessions-panel]") || triggerRef.current?.contains(t)) {
        return;
      }
      setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    doc.addEventListener("click", onDocClick);
    doc.addEventListener("keydown", onKey);
    return () => {
      doc.removeEventListener("click", onDocClick);
      doc.removeEventListener("keydown", onKey);
    };
  }, [open, doc]);

  if (!activeSession) return null;

  const headId = resolveSupersededChain(activeSession.id, sessions);
  const preds = listPredecessors(headId, sessions);

  if (preds.length === 0) return null;

  const isViewingPredecessor = preds.some((p) => p.id === activeSession.id);

  function handleTriggerClick() {
    if (open) {
      setOpen(false);
      return;
    }
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setMenuPos({ x: rect.left, y: rect.bottom });
    }
    setOpen(true);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn"
        aria-label="Previous sessions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={handleTriggerClick}
        title="Previous sessions"
      >
        <History size={14} />
      </button>

      {open && menuPos
        ? createPortal(
            <div
              className="menu-pop"
              data-previous-sessions-panel
              role="menu"
              aria-label="Previous sessions"
              style={{
                position: "fixed",
                top: menuPos.y + 6,
                left: Math.max(8, Math.min(menuPos.x, envWidth - 190)),
                minWidth: 180,
                zIndex: 4000,
              }}
            >
              <div className="menu-pop__title">Previous sessions</div>

              {isViewingPredecessor ? (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-pop__item"
                  onClick={() => {
                    setOpen(false);
                    onOpen(headId);
                  }}
                >
                  Back to current
                </button>
              ) : null}

              {preds.map((s) => {
                const isViewing = s.id === activeSession.id;
                const label = sessionLabel(s);
                const formattedTime = s.archivedAt ? formatArchivedTime(s.archivedAt) : "";
                const timeStr = formattedTime ? ` (${formattedTime})` : "";
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="menuitem"
                    className="menu-pop__item"
                    onClick={() => {
                      setOpen(false);
                      onOpen(s.id);
                    }}
                  >
                    <span>
                      {label}
                      {timeStr}
                    </span>
                    {isViewing ? <span style={{ marginLeft: "auto", opacity: 0.6 }}>Viewing</span> : null}
                  </button>
                );
              })}
            </div>,
            portalRoot,
          )
        : null}
    </>
  );
}
