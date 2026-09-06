import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  return {
    vstHome: () => tempDir,
    dbPath: () => pathJoin(tempDir, "vibe-station.db"),
  };
});

describe("tunnel-store", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-tunnel-store-test-"));
    // Fresh module graph per test so db.ts's cached connection doesn't leak
    // across temp dirs — mirrors the pattern in other state-store tests.
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("1.T1 — setState() then getState() round-trips all fields", async () => {
    const store = await import("../state/tunnel-store.js");
    store.setState({
      enabled: true,
      currentUrl: "https://x.trycloudflare.com",
      currentPid: 4242,
      startedAt: 1700000000000,
      port: 7421,
    });
    expect(store.getState()).toEqual({
      enabled: true,
      currentUrl: "https://x.trycloudflare.com",
      currentPid: 4242,
      startedAt: 1700000000000,
      port: 7421,
    });
  });

  it("1.T1 — clear() zeroes enabled/currentUrl/currentPid but the row still exists", async () => {
    const store = await import("../state/tunnel-store.js");
    store.setState({ enabled: true, currentUrl: "https://x.trycloudflare.com", currentPid: 4242, startedAt: 1, port: 7421 });
    store.clear();
    expect(store.getState()).toEqual({ enabled: false, currentUrl: null, currentPid: null, startedAt: null, port: null });
  });

  it("1.T1 — clearProcess() zeroes only currentUrl/currentPid and leaves enabled=true untouched", async () => {
    const store = await import("../state/tunnel-store.js");
    store.setState({ enabled: true, currentUrl: "https://x.trycloudflare.com", currentPid: 4242, startedAt: 1, port: 7421 });
    store.clearProcess();
    const state = store.getState();
    expect(state.enabled).toBe(true);
    expect(state.currentUrl).toBeNull();
    expect(state.currentPid).toBeNull();
  });

  it("1.T2 — getState() on a fresh DB (never set) returns the empty/disabled state without throwing", async () => {
    const store = await import("../state/tunnel-store.js");
    expect(store.getState()).toEqual({ enabled: false, currentUrl: null, currentPid: null, startedAt: null, port: null });
  });
});
