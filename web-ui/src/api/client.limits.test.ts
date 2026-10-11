import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClientApi } from "./client";
import type { LimitSlotRef, LimitsSnapshot } from "./types";

const SLOTS: [LimitSlotRef, LimitSlotRef] = [
  { harness: "claude", windowId: "five_hour" },
  { harness: "claude", windowId: "seven_day" },
];

const SNAPSHOT: LimitsSnapshot = {
  host: "test-host",
  slots: SLOTS,
  harnesses: [],
};

vi.stubGlobal("window", {
  location: { origin: "http://localhost:3000" },
});

let fetchMock: ReturnType<typeof vi.fn>;
type Call = [input: string, init?: RequestInit];

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => SNAPSHOT });
  vi.stubGlobal("fetch", fetchMock);
});

describe("limits client methods", () => {
  it("getLimits hits GET /api/limits", async () => {
    const api = createClientApi();
    const res = await api.getLimits();
    expect(res).toEqual(SNAPSHOT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as Call;
    expect(url).toBe("/api/limits");
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("refreshLimits hits POST /api/limits/refresh", async () => {
    const refreshRes = { started: true, retryAfterSecs: null, snapshot: SNAPSHOT };
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => refreshRes });
    const api = createClientApi();
    const res = await api.refreshLimits();
    expect(res).toEqual(refreshRes);
    const [url, init] = fetchMock.mock.calls[0] as Call;
    expect(url).toBe("/api/limits/refresh");
    expect(init?.method).toBe("POST");
  });

  it("setLimitSlots hits PUT /api/limits/slots with JSON body", async () => {
    const api = createClientApi();
    const res = await api.setLimitSlots(SLOTS);
    expect(res).toEqual(SNAPSHOT);
    const [url, init] = fetchMock.mock.calls[0] as Call;
    expect(url).toBe("/api/limits/slots");
    expect(init?.method).toBe("PUT");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({ slots: SLOTS });
  });
});
