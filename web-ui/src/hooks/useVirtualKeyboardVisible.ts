import { useEffect, useState } from "react";
import { useIsTouch } from "./useIsTouch";

/**
 * Whether the on-screen (virtual) keyboard is currently covering the viewport
 * on a touch device. Used to hide fixed bottom chrome (e.g. the global status
 * bar) that would otherwise overlap the keyboard or get pushed awkwardly.
 *
 * Gated on `useIsTouch()` so desktop window-resizes never trip it — on a
 * desktop a resized browser window also shrinks `visualViewport.height`, but
 * there is no keyboard, so nothing should hide. Mirrors the heuristic from
 * `SkillEditor.tsx`'s `useSoftKeyboardVisible` (visualViewport height drop vs.
 * the tracked no-keyboard baseline), but scoped to touch devices only.
 */
export function useVirtualKeyboardVisible(): boolean {
  const isTouch = useIsTouch();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Non-touch (desktop): never consider a keyboard present, regardless of
    // how the window is resized.
    if (!isTouch) {
      setVisible(false);
      return;
    }
    if (typeof window === "undefined" || !window.visualViewport) {
      setVisible(false);
      return;
    }

    // Track the maximum observed height as the no-keyboard baseline so a
    // keyboard-open detection works even when the hook mounts while the
    // keyboard is already open. 150px guards against minor browser chrome
    // (URL bar) changes being misread as a keyboard.
    const vp = window.visualViewport;
    const KEYBOARD_THRESHOLD_PX = 150;
    let maxHeight = vp.height;
    const update = () => {
      if (vp.height > maxHeight) maxHeight = vp.height;
      setVisible(maxHeight - vp.height > KEYBOARD_THRESHOLD_PX);
    };
    update();
    vp.addEventListener("resize", update);
    return () => vp.removeEventListener("resize", update);
  }, [isTouch]);

  return visible;
}
