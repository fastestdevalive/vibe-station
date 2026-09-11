import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ZoomableMedia } from "./ZoomableMedia";

interface ImageZoomOverlayProps {
  /** Image URL to show fullscreen; when null the overlay is closed. */
  src: string | null;
  alt?: string;
  onClose: () => void;
}

/**
 * Fullscreen zoom/pan overlay. Renders via `createPortal` to `document.body`
 * so it escapes any parent `overflow: hidden` container, locks body scroll
 * while open, and dismisses on Esc or the close button.
 *
 * The overlay is safe to mount/unmount freely — it holds no daemon stream (unlike
 * `TerminalPane`), so there is no React-tree-position invariant to preserve.
 */
export function ImageZoomOverlay({ src, alt, onClose }: ImageZoomOverlayProps) {
  const open = src != null;
  const [resetCount, setResetCount] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || !src) return null;

  return createPortal(
    <div
      className="image-zoom-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={alt ?? "Image fullscreen"}
    >
      <div className="image-zoom-overlay__controls">
        <button
          type="button"
          className="image-zoom-overlay__btn"
          onClick={() => setResetCount((c) => c + 1)}
          aria-label="Refit image"
          title="Refit (reset zoom)"
        >
          ⤾
        </button>
        <button
          type="button"
          className="image-zoom-overlay__btn"
          onClick={onClose}
          aria-label="Close fullscreen"
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>
      <ZoomableMedia src={src} alt={alt} fullscreen resetTrigger={resetCount} onTap={onClose} />
    </div>,
    document.body,
  );
}
