/**
 * How long a toggle's transition hint stays live (`useStore`'s `layoutTransitionHint`). Comfortably longer than the
 * 0.15s (`--transition-fast`) CSS transitions it gates, so the hint never lapses mid-animation. Lives here (no store
 * import) so it can be shared without a cycle.
 */
export const LAYOUT_TRANSITION_HINT_MS = 300;
