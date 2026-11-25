import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientApi } from "./client";
import { createMockApi } from "./mock";

vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });

let fetchMock: ReturnType<typeof vi.fn>;
type Call = [input: string, init?: RequestInit];

function res(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, statusText: "", headers: new Headers(), json: async () => body, text: async () => text };
}
const sentBody = (n: number) => JSON.parse((fetchMock.mock.calls[n] as Call)[1]!.body as string);

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.useRealTimers());

describe("sendChat clientMessageId", () => {
  it("always sends a 36-char id, a fresh one per call, and a caller-supplied id verbatim", async () => {
    fetchMock.mockResolvedValue(res(202, { turnId: "t", queuePosition: 0 }));
    const api = createClientApi();
    await api.sendChat("s", "a");
    await api.sendChat("s", "b");
    await api.sendChat("s", "c", undefined, undefined, undefined, undefined, "mine-1");
    expect(sentBody(0).clientMessageId).toHaveLength(36);
    expect(sentBody(1).clientMessageId).not.toBe(sentBody(0).clientMessageId);
    expect(sentBody(2).clientMessageId).toBe("mine-1");
  });

  it("accepts a 200 duplicate exactly like a 202", async () => {
    fetchMock.mockResolvedValue(res(200, { turnId: "t1", queuePosition: 0, delivery: "queued" }));
    await expect(createClientApi().sendChat("s", "a", undefined, undefined, undefined, undefined, "x")).resolves.toEqual({
      turnId: "t1",
      queuePosition: 0,
      delivery: "queued",
    });
  });

  it("retries once with the SAME body/id after a network failure (TypeError)", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(res(200, { turnId: "t1", queuePosition: 0 }));
    const p = createClientApi().sendChat("s", "a");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ turnId: "t1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(1)).toEqual(sentBody(0));
  });

  it("surfaces the error after the second network failure", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const p = createClientApi().sendChat("s", "a").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries an HTTP error response", async () => {
    fetchMock.mockResolvedValue(res(400, { error: "bad", code: "BAD_REQUEST" }));
    await expect(createClientApi().sendChat("s", "a")).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("mock sendChat idempotency (mirrors the daemon)", () => {
  it("a repeated clientMessageId returns the original turn and emits one user event carrying the id", async () => {
    const api = createMockApi();
    const events: Array<{ kind?: string; clientMessageId?: string }> = [];
    api.on("session:message", (m) => {
      if (m.type === "session:message") events.push(m.event);
    });
    const a = await api.sendChat("s1", "hi", undefined, undefined, undefined, undefined, "cm-1");
    const b = await api.sendChat("s1", "hi again", undefined, undefined, undefined, undefined, "cm-1");
    const c = await api.sendChat("s1", "other", undefined, undefined, undefined, undefined, "cm-2");
    expect(b).toEqual(a);
    expect(c.turnId).not.toBe(a.turnId);
    const users = events.filter((e) => e.kind === "user");
    expect(users).toHaveLength(2);
    expect(users[0]?.clientMessageId).toBe("cm-1");
  });
});
