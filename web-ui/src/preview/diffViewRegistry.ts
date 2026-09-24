/** Multi-instance registry for `interactive` `DiffView`s, resolved by DOM
 *  focus/containment at read time (not "last register wins") — see plan
 *  Decision 2 (revised). Relies on the interactive `DiffView`'s `rootEl`
 *  having `tabIndex={-1}` so an ordinary click actually moves
 *  `document.activeElement` there. */
export interface DiffViewController {
  rootEl: HTMLElement;
  toggleLayout(): void;
  toggleHunkAtFocus(): void;
}

const active = new Set<DiffViewController>();

/** Registers an interactive `DiffView` controller. Returns an unregister
 *  function; calling it more than once (a stale/duplicate unmount) is a
 *  no-op after the first call — `Set.delete` is idempotent. */
export function registerActiveDiffView(controller: DiffViewController): () => void {
  active.add(controller);
  return () => {
    active.delete(controller);
  };
}

/** Resolves the diff view a shortcut should act on: the registered instance
 *  whose `rootEl` contains `document.activeElement`, else — if exactly one
 *  instance is registered — that single instance (covers the common
 *  single-pane case without requiring an explicit click-to-focus first).
 *  Returns `null` when no instance is registered, or when focus is outside
 *  every registered instance and more than one is registered. */
export function getActiveDiffView(): DiffViewController | null {
  const focused = document.activeElement;
  for (const c of active) {
    if (focused && c.rootEl.contains(focused)) return c;
  }
  return active.size === 1 ? [...active][0]! : null;
}
