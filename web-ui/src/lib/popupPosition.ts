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
