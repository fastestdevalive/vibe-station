import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { usePortalRoot } from "@/context/DemoEnv";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Picker } from "./Picker";
import { useScopePickerStore } from "./scopePickerStore";
import "./scopeRow.css";

/**
 * Host of the per-worktree/project picker: `WallpaperMenuRow` opens it through
 * `scopePickerStore`, and this renders the same `Picker` in `scope` mode in a
 * centred modal (desktop) or a bottom sheet (phone).
 */
export function ScopePickerDialog() {
  const target = useScopePickerStore((s) => s.open);
  const close = useScopePickerStore((s) => s.close);
  const isMobile = useIsMobile();
  const portalRoot = usePortalRoot();
  const cardRef = useRef<HTMLDivElement>(null);
  const open = target !== null;

  // The desktop modal owns focus + Esc; the bottom sheet does both itself.
  useFocusTrap(cardRef, open && !isMobile);

  useEffect(() => {
    if (!open || isMobile) return undefined;
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Capture phase: this layer is on top, so it must see Esc before any
      // underlying menu/overlay handler.
      e.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, isMobile, close]);

  if (target === null) return null;

  // The Picker computes the Default tile's caption from the scope key it is given.
  const scope = { key: target.scope, label: target.label };
  const title = `Wallpaper · ${target.label}`;

  if (isMobile) {
    return (
      <BottomSheet open onClose={close} label={title}>
        <Picker mode="scope" scope={scope} onClose={close} />
      </BottomSheet>
    );
  }

  return createPortal(
    <div
      className="dialog-overlay wp-scope-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={cardRef}
        className="dialog-card wp-scope-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Picker mode="scope" scope={scope} onClose={close} />
      </div>
    </div>,
    portalRoot,
  );
}
