import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/errors";
import { createBulkRunner, type BulkAction, type BulkJob } from "./bulkRunner";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function captureJobs() {
  const jobs: BulkJob[] = [];
  return { jobs, onChange: (job: BulkJob) => jobs.push(job) };
}

function lastJob(jobs: BulkJob[]): BulkJob {
  const job = jobs.at(-1);
  if (!job) throw new Error("runner emitted no job");
  return job;
}

function gate(gates: Map<string, ReturnType<typeof deferred>>, id: string) {
  const g = gates.get(id);
  if (!g) throw new Error(`no gate for ${id}`);
  return g;
}

describe("createBulkRunner", () => {
  it("runs items in order, never more than one in flight with concurrency 1", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const run = vi.fn(async (_action: BulkAction, id: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(id);
      await gate(gates, id).promise;
      inFlight -= 1;
    });
    const { jobs, onChange } = captureJobs();
    const runner = createBulkRunner({ run, isGone: () => false, onChange });
    for (const id of ["a", "b", "c"]) gates.set(id, deferred());

    const job = runner.start("delete", [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ]);
    expect(job?.items.map((item) => item.status)).toEqual(["queued", "queued", "queued"]);

    // Only the first item may start while it is still in flight.
    expect(order).toEqual(["a"]);
    gate(gates, "a").resolve();
    await vi.waitFor(() => expect(order).toEqual(["a", "b"]));
    gate(gates, "b").resolve();
    await vi.waitFor(() => expect(order).toEqual(["a", "b", "c"]));
    gate(gates, "c").resolve();
    await vi.waitFor(() => expect(lastJob(jobs).finished).toBe(true));

    expect(maxInFlight).toBe(1);
    expect(lastJob(jobs).items.map((item) => item.status)).toEqual(["done", "done", "done"]);
  });

  it("maps isGone errors to done, other errors to failed, and continues the job", async () => {
    const gone = new Error("gone");
    const run = vi.fn(async (_action: BulkAction, id: string) => {
      if (id === "gone") throw gone;
      if (id === "bad") throw new Error("boom");
    });
    const onItemDone = vi.fn();
    const { jobs, onChange } = captureJobs();
    const runner = createBulkRunner({ run, isGone: (err) => err === gone, onChange, onItemDone });

    runner.start("archive", [
      { id: "gone", label: "Gone" },
      { id: "bad", label: "Bad" },
      { id: "ok", label: "Ok" },
    ]);
    await vi.waitFor(() => expect(lastJob(jobs).finished).toBe(true));

    const items = lastJob(jobs).items;
    expect(items.map((item) => item.status)).toEqual(["done", "failed", "done"]);
    expect(items[1]?.error).toBe("boom");
    expect(run).toHaveBeenCalledTimes(3);
    // Already-gone counts as done, so its side effect still fires.
    expect(onItemDone.mock.calls).toEqual([
      ["gone", "archive"],
      ["ok", "archive"],
    ]);
  });

  it("cancelRemaining cancels queued items while the running one finishes", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const run = vi.fn(async (_action: BulkAction, id: string) => {
      await gate(gates, id).promise;
    });
    const { jobs, onChange } = captureJobs();
    const runner = createBulkRunner({ run, isGone: () => false, onChange });
    for (const id of ["a", "b", "c"]) gates.set(id, deferred());

    runner.start("delete", [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ]);
    runner.cancelRemaining();

    const cancelled = lastJob(jobs);
    expect(cancelled.cancelRequested).toBe(true);
    expect(cancelled.finished).toBe(false);
    expect(cancelled.items.map((item) => item.status)).toEqual([
      "running",
      "cancelled",
      "cancelled",
    ]);

    gate(gates, "a").resolve();
    await vi.waitFor(() => expect(lastJob(jobs).finished).toBe(true));
    expect(lastJob(jobs).items.map((item) => item.status)).toEqual([
      "done",
      "cancelled",
      "cancelled",
    ]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retry re-runs only failed and cancelled items", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const started: string[] = [];
    const run = vi.fn(async (_action: BulkAction, id: string) => {
      started.push(id);
      await gate(gates, id).promise;
    });
    const { jobs, onChange } = captureJobs();
    const runner = createBulkRunner({ run, isGone: () => false, onChange });
    for (const id of ["a", "b", "c"]) gates.set(id, deferred());

    runner.start("delete", [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ]);
    gate(gates, "a").resolve();
    await vi.waitFor(() => expect(started).toEqual(["a", "b"]));
    runner.cancelRemaining(); // c -> cancelled while b runs
    gate(gates, "b").reject(new Error("first attempt"));
    await vi.waitFor(() => expect(lastJob(jobs).finished).toBe(true));
    expect(lastJob(jobs).items.map((item) => item.status)).toEqual([
      "done",
      "failed",
      "cancelled",
    ]);

    // Fresh gates for the retried items; `a` must never run again.
    gates.set("b", deferred());
    gates.set("c", deferred());
    runner.retry();
    expect(lastJob(jobs).finished).toBe(false);
    expect(lastJob(jobs).items.map((item) => item.status)).toEqual(["done", "running", "queued"]);

    gate(gates, "b").resolve();
    await vi.waitFor(() => expect(started).toEqual(["a", "b", "b", "c"]));
    gate(gates, "c").resolve();
    await vi.waitFor(() => expect(lastJob(jobs).finished).toBe(true));
    expect(lastJob(jobs).items.map((item) => item.status)).toEqual(["done", "done", "done"]);
  });

  it("start is a no-op while a job is unfinished and for an empty item list", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const { jobs, onChange } = captureJobs();
    const runner = createBulkRunner({
      run: async (_action: BulkAction, id: string) => {
        await gate(gates, id).promise;
      },
      isGone: () => false,
      onChange,
    });
    gates.set("a", deferred());

    expect(runner.start("delete", [])).toBeNull();
    const first = runner.start("delete", [{ id: "a", label: "A" }]);
    expect(first).not.toBeNull();
    expect(runner.start("archive", [{ id: "b", label: "B" }])).toBeNull();

    gate(gates, "a").resolve();
    await vi.waitFor(() => expect(lastJob(jobs).finished).toBe(true));
    const second = runner.start("archive", [{ id: "b", label: "B" }]);
    expect(second?.action).toBe("archive");
    await vi.waitFor(() => expect(lastJob(jobs).finished).toBe(true));
  });

  it.each([
    [new ApiError('{"error":"directory is in use"}', 500), "directory is in use"],
    [new ApiError('{"message":"nope"}', 500), "nope"],
    [new Error("boom"), "boom"],
    [new ApiError("null", 500), "null"],
  ])("extracts a readable failure message from %s", async (thrown, expected) => {
    const { jobs, onChange } = captureJobs();
    const runner = createBulkRunner({
      run: async () => {
        throw thrown;
      },
      isGone: () => false,
      onChange,
    });
    runner.start("delete", [{ id: "a", label: "A" }]);
    await vi.waitFor(() => expect(lastJob(jobs).finished).toBe(true));
    expect(lastJob(jobs).items[0]).toMatchObject({ status: "failed", error: expected });
  });
});
