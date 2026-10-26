import type { ReactNode } from "react";
import { ArrowUp, RefreshCw, AlertTriangle } from "lucide-react";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import { skipUpdate } from "@/api/update";
import { chipView, type ChipState } from "./updateView";
import "@/styles/update.css";

export interface UpdateChipProps {
  className?: string;
}

export function UpdateChip({ className = "" }: UpdateChipProps) {
  const inRouter = useInRouterContext();
  if (inRouter) {
    return <UpdateChipWithRouter className={className} />;
  }
  return (
    <UpdateChipContent
      className={className}
      onNavigate={(path) => {
        if (typeof window !== "undefined") {
          window.location.pathname = path;
        }
      }}
    />
  );
}

function UpdateChipWithRouter({ className = "" }: UpdateChipProps) {
  const navigate = useNavigate();
  return <UpdateChipContent className={className} onNavigate={(path) => navigate(path)} />;
}

const CHIP_ICON: Record<ChipState, ReactNode> = {
  installing: <span className="update-chip__spinner" aria-hidden="true" />,
  restart: <RefreshCw size={12} aria-hidden="true" />,
  "rolled-back": <AlertTriangle size={12} aria-hidden="true" />,
  available: <ArrowUp size={12} aria-hidden="true" />,
};

/**
 * The TopBar chip button only. Its dialog, Undo toast, stage announcer and the
 * restart overlay are app-global and live in `UpdateLayer`.
 */
function UpdateChipContent({
  className = "",
  onNavigate,
}: UpdateChipProps & { onNavigate: (path: string) => void }) {
  const status = useUpdateStore((s) => s.status);
  const canInstall = useUpdateStore((s) => s.canInstall);
  const remindedFor = useUpdateStore((s) => s.remindedFor);
  const setDialogOpen = useUpdateStore((s) => s.setDialogOpen);
  const isNarrow = useMediaQuery("(max-width: 639px)");

  const view = chipView(status, canInstall, remindedFor);
  if (!view) return null;

  const handleChipClick = () => {
    if (view.state === "rolled-back") {
      onNavigate("/settings/updates");
    } else {
      setDialogOpen(true);
    }
  };

  const handleSkip = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const latest = status?.latest;
    if (!latest) return;
    try {
      const nextStatus = await skipUpdate(latest);
      const store = useUpdateStore.getState();
      store.setStatus(nextStatus);
      // Store-held so the Undo toast survives a TopBar variant swap and is
      // shared with the dialog's Skip.
      store.setUndoSkipVersion(latest);
    } catch {
      // Best-effort
    }
  };

  return (
    <span
      className={`update-chip update-chip--${view.state} ${
        isNarrow ? "update-chip--icon-only" : ""
      } ${className}`.trim()}
    >
      <button
        type="button"
        className="update-chip__main"
        aria-label={view.ariaLabel}
        onClick={handleChipClick}
      >
        {CHIP_ICON[view.state]}
        <span className="update-chip__label">{view.label}</span>
      </button>
      {view.showSkip ? (
        <button
          type="button"
          className="update-chip__skip"
          aria-label={`Skip version ${status?.latest ?? ""}`}
          onClick={handleSkip}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
