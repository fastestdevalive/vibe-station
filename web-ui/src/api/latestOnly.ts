/**
 * Single-flight with one trailing run, per key.
 *
 * Watcher-driven reads (file body, diff, gutter, tree, changed paths) are
 * re-issued on every `tree:changed` / `file:changed` / `ws:open`. The callers
 * only drop a superseded RESULT (a `cancelled` flag) — the request itself keeps
 * running. Under sustained churn in a worktree (a git checkout/rewrite, a
 * build) requests were therefore issued faster than a slow route (`git status`
 * behind `changed-paths`) answers them, and piled up without bound: the
 * browser's per-origin connection queue filled (every other request, and any
 * new tab on the same origin, hung behind it) and past ~1.3k pending requests
 * Chrome failed new fetches outright ("Failed to fetch").
 *
 * `run(key, fn)` bounds that to at most two logical requests per key:
 *   - nothing in flight: start `fn` now;
 *   - one in flight: queue ONE run that starts when it settles; every caller
 *     arriving meanwhile shares that queued run.
 * A queued run always STARTS after the call that asked for it, so its result
 * is never older than the change that triggered the call — sharing the
 * in-flight request instead would hand back pre-change data.
 */
export function createLatestOnly() {
  type Slot = { queued: { promise: Promise<unknown>; start: () => void } | null };
  const slots = new Map<string, Slot>();

  async function exec<T>(key: string, slot: Slot, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      const q = slot.queued;
      if (q) {
        slot.queued = null;
        q.start();
      } else {
        slots.delete(key);
      }
    }
  }

  return function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const slot = slots.get(key);
    if (!slot) {
      const fresh: Slot = { queued: null };
      slots.set(key, fresh);
      return exec(key, fresh, fn);
    }
    if (!slot.queued) {
      let start!: () => void;
      const gate = new Promise<void>((resolve) => {
        start = resolve;
      });
      slot.queued = { promise: gate.then(() => exec(key, slot, fn)), start };
    }
    return slot.queued.promise as Promise<T>;
  };
}
