import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useEventTargets, usePortalRoot, useViewportWidth } from "@/context/DemoEnv";
import { startAlignedPopupPosition } from "@/lib/popupPosition";
import type { SwitchFallback } from "./useAccountSwitch";
import "./accounts.css";

interface SwitchRefusalProps {
  /** The daemon's reason (or the generic sentence). */
  message: string;
  /** The one way forward after a refused hand-over, when there is one. */
  fallback: SwitchFallback | null;
  /** The control the notice hangs off (its rect places the popover). */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/**
 * A refused account switch (R6F-05): the reason plus the one fallback button,
 * in a portaled, `position: fixed` popover (a bottom sheet on phones) so a
 * narrow toolbar or status bar can never clip it or shrink the account chip.
 * The text wraps in the `role="alert"` paragraph; the button sits beside it in
 * the same container. Escape closes and returns focus to the trigger.
 */
export function SwitchRefusal({ message, fallback, anchorRef, onClose }: SwitchRefusalProps) {
  const isMobile = useIsMobile();
  const { doc } = useEventTargets();
  const portalRoot = usePortalRoot();
  const envWidth = useViewportWidth();
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (isMobile) return;
    const el = rootRef.current;
    const trigger = anchorRef.current;
    if (!el || !trigger) return;
    const box = el.getBoundingClientRect();
    const next = startAlignedPopupPosition(
      trigger.getBoundingClientRect(),
      box.width,
      box.height,
      envWidth,
      portalRoot.ownerDocument.documentElement.clientHeight,
    );
    setPos((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
  }, [isMobile, anchorRef, envWidth, portalRoot, message, fallback]);

  // Take focus once the popover is placed and visible (a `visibility: hidden`
  // element cannot be focused): the fallback button, else the container.
  const focused = useRef(false);
  const visible = isMobile || pos !== null;
  useEffect(() => {
    if (!visible || focused.current) return;
    focused.current = true;
    (rootRef.current?.querySelector<HTMLElement>("[data-primary]") ?? rootRef.current)?.focus();
  }, [visible]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    doc.addEventListener("mousedown", onDown);
    return () => doc.removeEventListener("mousedown", onDown);
  }, [doc, onClose, anchorRef]);

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Tab") {
      // Portaled to the end of the DOM: keep Tab inside while the notice is open.
      const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
      const first = items[0];
      const last = items[items.length - 1];
      const active = rootRef.current?.ownerDocument.activeElement;
      if (!first || !last) return;
      if (e.shiftKey && (active === first || active === rootRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.nativeEvent.stopImmediatePropagation();
    onClose();
    anchorRef.current?.focus();
  }

  const body = (
    <div
      ref={rootRef}
      className="switch-refusal"
      data-testid="switch-refusal"
      tabIndex={-1}
      style={isMobile ? undefined : { top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
      onKeyDown={onKeyDown}
    >
      <p className="switch-refusal__text" role="alert">
        {message}
      </p>
      {fallback ? (
        <button type="button" data-primary className="account-banner__btn switch-refusal__btn" onClick={fallback.run}>
          {fallback.label}
        </button>
      ) : null}
      <button
        type="button"
        className="account-banner__btn switch-refusal__btn"
        onClick={() => {
          onClose();
          anchorRef.current?.focus();
        }}
      >
        Dismiss
      </button>
    </div>
  );
  return createPortal(body, portalRoot);
}
