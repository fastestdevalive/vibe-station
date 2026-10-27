import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEventTargets } from "@/context/DemoEnv";

/** Text entry and overlays own their Esc. Checkboxes/radios/buttons deliberately do NOT (Follow / Wrap). */
export const ESC_IGNORED_SELECTOR =
  "input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select, [contenteditable], [role=dialog], [role=menu], [role=listbox]";

function ignoredTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ESC_IGNORED_SELECTOR) !== null;
}

function modalOpen(): boolean {
  return document.querySelector("[role=dialog][aria-modal=true]") !== null;
}

/**
 * Esc closes the task view (D12). Two paths, both `stopPropagation`:
 *  - `onKeyDown` for the view's root (focus inside the view);
 *  - a capture-phase window fallback, only while focus rests on `<body>` and this pane's session is the
 *    active one. Capturing + stopping keeps the canvas' bubble listener (exit tile fullscreen) from also firing.
 */
export function useTaskEsc({ onClose, enabled, isActiveSession }: { onClose: () => void; enabled: boolean; isActiveSession: boolean }) {
  const { win } = useEventTargets();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const activeRef = useRef(isActiveSession);
  activeRef.current = isActiveSession;

  useEffect(() => {
    if (!enabled) return;
    const handler = (ev: Event) => {
      const e = ev as KeyboardEvent;
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (!activeRef.current || document.activeElement !== document.body || modalOpen()) return;
      e.stopPropagation();
      closeRef.current();
    };
    win.addEventListener("keydown", handler, { capture: true });
    return () => win.removeEventListener("keydown", handler, { capture: true });
  }, [enabled, win]);

  return {
    onKeyDown(e: ReactKeyboardEvent) {
      if (!enabled || e.key !== "Escape") return;
      if (e.defaultPrevented || e.nativeEvent.isComposing) return;
      if (ignoredTarget(e.target) || modalOpen()) return;
      e.stopPropagation();
      e.preventDefault();
      closeRef.current();
    },
  };
}
