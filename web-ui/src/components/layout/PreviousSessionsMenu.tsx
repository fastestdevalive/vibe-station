import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { History } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { resolveSupersededChain, listPredecessors } from "@/lib/sessionVisibility";
import { useEventTargets, usePortalRoot, useViewportWidth } from "@/context/DemoEnv";
import { PreviousSessionsList } from "./PreviousSessionsList";

export interface PreviousSessionsMenuProps {
  api: ApiInstance;
  activeSession: Session | null;
  sessions: Session[];
  onOpen: (id: string) => void;
}

/**
 * "Previous sessions" icon + popover for a superseded agent chain. The row
 * body is the shared `PreviousSessionsList` (also used by the pane dialog).
 * Hidden entirely when the chain has no predecessors.
 */
export function PreviousSessionsMenu({ api, activeSession, sessions, onOpen }: PreviousSessionsMenuProps) {
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

  const headId = activeSession ? resolveSupersededChain(activeSession.id, sessions) : null;
  const preds = headId ? listPredecessors(headId, sessions) : [];

  if (!activeSession) return null;
  if (preds.length === 0) return null;

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
              className="menu-pop prev-sessions"
              data-previous-sessions-panel
              role="menu"
              aria-label="Previous sessions"
              style={{
                position: "fixed",
                top: menuPos.y + 6,
                left: Math.max(8, Math.min(menuPos.x, envWidth - 270)),
                minWidth: 250,
                zIndex: 4000,
              }}
            >
              <div className="menu-pop__title">Previous sessions</div>
              <PreviousSessionsList
                api={api}
                activeSession={activeSession}
                sessions={sessions}
                onOpen={onOpen}
                onNavigate={() => setOpen(false)}
              />
            </div>,
            portalRoot,
          )
        : null}
    </>
  );
}
