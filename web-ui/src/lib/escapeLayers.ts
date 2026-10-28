/**
 * Esc layers for the review-comment UI (Decision 15). Called first by `handleToolsEsc`: the topmost open layer
 * takes the key and the files-panel / fullscreen handling below it only runs when no layer did.
 *
 * Order, top first: the send picker, the open comment box or rendered-markdown card (a box confirms a discard when it holds text), the
 * expanded tray. Portaled layers (picker, `BottomSheet`) never reach the tools-pane root listener, so they
 * handle their own Esc and register here only for ordering. Esc inside the terminal or the composer is never
 * swallowed: those targets are outside every tools root, and a layer is only dismissed from inside one.
 */
export type EscapeLayerId = "picker" | "comment-box" | "tray";

/** Return `false` to pass (nothing to dismiss right now); anything else means the key was handled. */
export type EscapeLayerHandler = () => boolean | void;

/**
 * The element a layer belongs to (a tools pane). Several tools panes can be mounted at once (canvas tiles): a key
 * pressed inside pane A must not close a layer owned by pane B. `null` (or no scope) means "applies anywhere" (the
 * portaled picker).
 */
export type EscapeLayerScope = () => Element | null;

const RANK: Record<EscapeLayerId, number> = { picker: 0, "comment-box": 1, tray: 2 };

interface Entry {
  id: EscapeLayerId;
  handler: EscapeLayerHandler;
  scope?: EscapeLayerScope;
  seq: number;
}

let seq = 0;
const layers = new Set<Entry>();

/** Register a layer for as long as it is open. Returns the unregister function. */
export function registerEscapeLayer(id: EscapeLayerId, handler: EscapeLayerHandler, scope?: EscapeLayerScope): () => void {
  const entry: Entry = { id, handler, scope, seq: ++seq };
  layers.add(entry);
  return () => {
    layers.delete(entry);
  };
}

/** Layers currently open, top first (for tests and diagnostics). */
export function openEscapeLayers(): EscapeLayerId[] {
  return orderedEntries().map((e) => e.id);
}

function orderedEntries(): Entry[] {
  // Same layer twice (two boxes): the most recently opened one is on top.
  return [...layers].sort((a, b) => RANK[a.id] - RANK[b.id] || b.seq - a.seq);
}

/**
 * Dismiss the topmost layer that accepts the key. True when one did. With a `target`, a layer scoped to another
 * element than the one containing it is skipped.
 */
export function dismissTop(target?: EventTarget | null): boolean {
  for (const entry of orderedEntries()) {
    const owner = target instanceof Node ? (entry.scope?.() ?? null) : null;
    if (owner && !owner.contains(target as Node)) continue;
    if (entry.handler() !== false) return true;
  }
  return false;
}
