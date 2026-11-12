export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PopupPositionResult {
  top: number;
  left: number;
}

/**
 * Like `clampPopupPosition`, but the popup's LEFT edge starts on the trigger's
 * left edge (a menu that hangs off its trigger), with a 4px gap by default.
 * Opens below when it fits, otherwise above; clamped 8px inside the viewport.
 */
export function startAlignedPopupPosition(
  triggerRect: RectLike,
  popupWidth: number,
  popupHeight: number,
  envWidth: number,
  envHeight: number,
  gap = 4,
): PopupPositionResult {
  return clampPopupPosition({
      // Named fields: a real DOMRect keeps them as prototype getters, which a spread drops.
      top: triggerRect.top,
      bottom: triggerRect.bottom,
      left: triggerRect.left,
      right: triggerRect.left + popupWidth,
    }, popupWidth, popupHeight, envWidth, envHeight, gap);
}

/**
 * Clamps popup position so it never overflows any edge of the viewport.
 *
 * - Horizontal: aligns right edge with trigger button by default; clamped between 8px and envWidth - popupWidth - 8px.
 * - Vertical: opens below trigger by default (triggerRect.bottom + 6px).
 *   If opening below would overflow the bottom edge (top + popupHeight > envHeight - 8px),
 *   it flips to open above the trigger (triggerRect.top - popupHeight - 6px).
 *   If the window is so short that opening above would overflow the top, it is clamped to stay within [8px, envHeight - popupHeight - 8px].
 */
export function clampPopupPosition(
  triggerRect: RectLike,
  popupWidth: number,
  popupHeight: number,
  envWidth: number,
  envHeight: number,
  gap = 6,
  margin = 8,
): PopupPositionResult {
  // Screen boundaries check: ensure it does not overflow viewport horizontally
  let left = triggerRect.right - popupWidth;
  if (left + popupWidth > envWidth - margin) {
    left = envWidth - popupWidth - margin;
  }
  if (left < margin) {
    left = margin;
  }

  // Screen boundaries check: ensure it does not overflow viewport vertically
  let top = triggerRect.bottom + gap;
  if (top + popupHeight > envHeight - margin) {
    top = Math.max(margin, triggerRect.top - popupHeight - gap);
  }
  if (top + popupHeight > envHeight - margin) {
    top = Math.max(margin, envHeight - popupHeight - margin);
  }

  return { top, left };
}

/**
 * The height a popup may use: the document's client height, or the top edge of
 * the bottom `.global-status-bar` when it is shown and sits higher.
 */
export function usablePopupHeight(doc: Document): number {
  const full = doc.documentElement.clientHeight;
  const rect = doc.querySelector(".global-status-bar")?.getBoundingClientRect();
  if (rect && rect.height > 0 && rect.top < full) return rect.top;
  return full;
}
