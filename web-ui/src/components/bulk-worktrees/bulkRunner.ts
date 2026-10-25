/**
 * Sequential bulk-worktree job engine — pure: no React, no api import.
 *
 * Owns at most one job at a time. `onChange` fires after EVERY item
 * transition with a NEW immutable `BulkJob` (never mutated in place), so the
 * UI renders straight from it. `start` refuses while an unfinished job
 * exists; `cancelRemaining` stops only not-yet-started items and `retry`
 * re-queues failed/cancelled ones. Item errors never escape: a rejected `run`
 * marks that item `failed` (or `done` when `isGone` says it is already gone)
 * and the rest of the job continues.
 */

export type BulkAction = "archive" | "delete";

export type BulkItemStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface BulkItem {
  id: string;
  /** Display label resolved when the job was created (confirm time). */
  label: string;
  status: BulkItemStatus;
  /** Failure reason — set only when `status === "failed"`. */
  error?: string;
}

export interface BulkJob {
  /** Monotonic per-runner id, so a later job is distinguishable from an earlier one. */
  id: number;
  action: BulkAction;
  items: BulkItem[];
  finished: boolean;
  cancelRequested: boolean;
}

export interface BulkRunnerDeps {
  /** Performs one item. Throws on failure; a 404 is recognised by `isGone`. */
  run: (action: BulkAction, id: string) => Promise<void>;
  /** True when `err` means "already gone" — the item then counts as done. */
  isGone: (err: unknown) => boolean;
  /** Called after every transition, with a NEW immutable job. */
  onChange: (job: BulkJob) => void;
  /** Side effects after an item succeeds (or is already gone). */
  onItemDone?: (id: string, action: BulkAction) => void;
  /** Parallel items; default 1 (worktree removal is disk/git heavy). */
  concurrency?: number;
}

export interface BulkRunner {
  /** The new job, or null (no-op) when a job is unfinished or `items` is empty. */
  start: (action: BulkAction, items: { id: string; label: string }[]) => BulkJob | null;
  /** Queued items become `cancelled`; an in-flight item finishes normally. */
  cancelRemaining: () => void;
  /** Failed + cancelled items go back to `queued` and the job resumes. */
  retry: () => void;
}

function withItem(job: BulkJob, id: string, patch: Partial<BulkItem>): BulkJob {
  return { ...job, items: job.items.map((item) => (item.id === id ? { ...item, ...patch } : item)) };
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    // ApiError carries the daemon's raw `{ error, code? }` body as its message.
    const body = JSON.parse(raw) as { error?: unknown; message?: unknown } | null;
    if (body && typeof body.error === "string" && body.error) return body.error;
    if (body && typeof body.message === "string" && body.message) return body.message;
  } catch {
    /* not JSON — keep the raw text */
  }
  return raw;
}

export function createBulkRunner(deps: BulkRunnerDeps): BulkRunner {
  const concurrency = Math.max(1, Math.floor(deps.concurrency ?? 1));

  let job: BulkJob | null = null;
  let nextId = 0;
  let draining = false;
  let restartRequested = false;

  function emit(next: BulkJob): void {
    job = next;
    deps.onChange(next);
  }

  async function runItem(jobId: number, item: BulkItem): Promise<void> {
    const started = job;
    if (!started || started.id !== jobId) return;
    emit(withItem(started, item.id, { status: "running" }));
    try {
      await deps.run(started.action, item.id);
      const current = job;
      if (!current || current.id !== jobId) return;
      emit(withItem(current, item.id, { status: "done" }));
      deps.onItemDone?.(item.id, started.action);
    } catch (err) {
      const current = job;
      if (!current || current.id !== jobId) return;
      if (deps.isGone(err)) {
        emit(withItem(current, item.id, { status: "done" }));
        deps.onItemDone?.(item.id, started.action);
      } else {
        emit(withItem(current, item.id, { status: "failed", error: errorMessage(err) }));
      }
    }
  }

  async function drain(jobId: number): Promise<void> {
    if (draining) return;
    draining = true;
    const inFlight = new Set<Promise<void>>();
    try {
      for (;;) {
        const current = job;
        if (!current || current.id !== jobId) return;

        // Re-read `job` each iteration: `runItem` emits synchronously, so a
        // stale snapshot would keep finding the same item "queued".
        while (inFlight.size < concurrency) {
          const snapshot = job;
          if (!snapshot || snapshot.id !== jobId) return;
          const next = snapshot.items.find((item) => item.status === "queued");
          if (!next) break;
          const promise = runItem(jobId, next).finally(() => {
            inFlight.delete(promise);
          });
          inFlight.add(promise);
        }

        if (inFlight.size === 0) {
          const finalJob = job;
          if (!finalJob) return;
          if (!finalJob.finished) emit({ ...finalJob, finished: true });
          return;
        }

        await Promise.race(inFlight);
      }
    } finally {
      draining = false;
      // A retry issued from inside the final `onChange` still needs a drain.
      if (restartRequested) {
        restartRequested = false;
        const pending = job;
        if (pending && !pending.finished) void drain(pending.id);
      }
    }
  }

  function start(action: BulkAction, items: { id: string; label: string }[]): BulkJob | null {
    if (items.length === 0) return null;
    if (job && !job.finished) return null;
    const next: BulkJob = {
      id: ++nextId,
      action,
      items: items.map((item) => ({ id: item.id, label: item.label, status: "queued" })),
      finished: false,
      cancelRequested: false,
    };
    emit(next);
    void drain(next.id);
    return next;
  }

  function cancelRemaining(): void {
    const current = job;
    if (!current || current.finished) return;
    if (!current.items.some((item) => item.status === "queued")) return;
    emit({
      ...current,
      cancelRequested: true,
      items: current.items.map((item) =>
        item.status === "queued" ? { ...item, status: "cancelled" as const } : item,
      ),
    });
  }

  function retry(): void {
    const current = job;
    if (!current) return;
    if (!current.items.some((item) => item.status === "failed" || item.status === "cancelled")) {
      return;
    }
    emit({
      ...current,
      finished: false,
      cancelRequested: false,
      items: current.items.map((item) =>
        item.status === "failed" || item.status === "cancelled"
          ? { id: item.id, label: item.label, status: "queued" as const }
          : item,
      ),
    });
    if (draining) {
      restartRequested = true;
      return;
    }
    void drain(current.id);
  }

  return { start, cancelRemaining, retry };
}
