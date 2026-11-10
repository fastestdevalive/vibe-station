import { describe, expect, it } from "vitest";
import { createLatestOnly } from "./latestOnly";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createLatestOnly", () => {
  it("runs at most one request in flight plus one queued per key, however many callers arrive", async () => {
    const run = createLatestOnly();
    const gates: Array<ReturnType<typeof deferred<number>>> = [];
    let started = 0;
    const fn = () => {
      started += 1;
      const d = deferred<number>();
      gates.push(d);
      return d.promise;
    };

    const first = run("k", fn);
    const callers = Array.from({ length: 500 }, () => run("k", fn));
    await tick();
    expect(started).toBe(1);

    gates[0]!.resolve(1);
    expect(await first).toBe(1);
    await tick();
    // The queued run starts only after the first settled — so it reflects state
    // newer than every call that was waiting on it.
    expect(started).toBe(2);

    gates[1]!.resolve(2);
    expect(await Promise.all(callers)).toEqual(Array(500).fill(2));
    expect(started).toBe(2);
  });

  it("starts a fresh request once the key is idle again", async () => {
    const run = createLatestOnly();
    let started = 0;
    const fn = async () => ++started;
    expect(await run("k", fn)).toBe(1);
    expect(await run("k", fn)).toBe(2);
  });

  it("keeps keys independent", async () => {
    const run = createLatestOnly();
    const a = deferred<string>();
    let bStarted = false;
    const pa = run("a", () => a.promise);
    const pb = run("b", async () => {
      bStarted = true;
      return "b";
    });
    expect(await pb).toBe("b");
    expect(bStarted).toBe(true);
    a.resolve("a");
    expect(await pa).toBe("a");
  });

  it("a failed request rejects only its own callers and still releases the queued run", async () => {
    const run = createLatestOnly();
    const a = deferred<string>();
    const first = run("k", () => a.promise);
    const second = run("k", async () => "ok");
    a.reject(new Error("Failed to fetch"));
    await expect(first).rejects.toThrow("Failed to fetch");
    expect(await second).toBe("ok");
    // Slot is released: the next call runs immediately.
    expect(await run("k", async () => "again")).toBe("again");
  });
});
