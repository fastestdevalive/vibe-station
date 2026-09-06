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

describe("auth-session-store — tunnelUrl (tunnel-persistence)", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-auth-session-store-test-"));
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("1.T4 — issue() with tunnelUrl persists it, list() returns it", async () => {
    const store = await import("../state/auth-session-store.js");
    store.issue("nonce-1", { createdVia: "qr", tunnelUrl: "https://x.trycloudflare.com" });
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tunnelUrl).toBe("https://x.trycloudflare.com");
  });

  it("1.T4 — issue() with no tunnelUrl yields null in list()", async () => {
    const store = await import("../state/auth-session-store.js");
    store.issue("nonce-2", { createdVia: "password" });
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tunnelUrl).toBeNull();
  });

  it("issue() with no tunnelUrl for a local-network qr session also yields null", async () => {
    const store = await import("../state/auth-session-store.js");
    store.issue("nonce-3", { createdVia: "qr" });
    const rows = store.list();
    expect(rows[0]?.tunnelUrl).toBeNull();
  });
});
