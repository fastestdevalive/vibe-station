import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { TailscaleRuleNotOursError } from "../services/tailscaleServe.js";
import { mintToken } from "../auth.js";
import type { AuthState } from "../state/auth-state.js";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  return {
    vstHome: () => tempDir,
    dbPath: () => pathJoin(tempDir, "vibe-station.db"),
    daemonLogPath: () => pathJoin(tempDir, "logs", "daemon.log"),
  };
});

vi.mock("../services/tailscaleServe.js", async () => {
  const actual = await vi.importActual<typeof import("../services/tailscaleServe.js")>(
    "../services/tailscaleServe.js",
  );
  return {
    ...actual,
    getStatus: vi.fn(),
    enableServe: vi.fn(),
    disableServe: vi.fn(),
    runUp: vi.fn(),
  };
});

import * as tailscaleService from "../services/tailscaleServe.js";
import type { TailscaleStatus } from "../services/tailscaleServe.js";

describe("tailscale routes", () => {
  let app: FastifyInstance;
  const port = 7421;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-tailscale-routes-"));
    vi.resetModules();
    vi.clearAllMocks();
    app = await (await import("../server.js")).buildServer({ authState: undefined, port });
  });

  afterEach(async () => {
    await app?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("GET /tailscale/status returns the resolved status", async () => {
    vi.mocked(tailscaleService.getStatus).mockResolvedValue({
      state: "serve_active",
      httpsUrl: "https://machine.tail0123.ts.net",
    });
    const res = await app.inject({ method: "GET", url: "/tailscale/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      state: "serve_active",
      httpsUrl: "https://machine.tail0123.ts.net",
    });
  });

  it("POST /tailscale/serve/enable returns httpsUrl on success", async () => {
    vi.mocked(tailscaleService.enableServe).mockResolvedValue({
      httpsUrl: "https://machine.tail0123.ts.net",
    });
    const res = await app.inject({ method: "POST", url: "/tailscale/serve/enable" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      httpsUrl: "https://machine.tail0123.ts.net",
      enabled: true,
    });
  });

  it("POST /tailscale/serve/enable returns 409 CERT_NEEDS_ENABLEMENT with the ACME URL", async () => {
    const err = new Error("certs needed") as Error & { enableUrl?: string };
    err.enableUrl = "https://login.tailscale.com/admin/dns#enable-https";
    vi.mocked(tailscaleService.enableServe).mockRejectedValue(err);
    const res = await app.inject({ method: "POST", url: "/tailscale/serve/enable" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "CERT_NEEDS_ENABLEMENT",
      enableUrl: "https://login.tailscale.com/admin/dns#enable-https",
    });
  });

  it("POST /tailscale/serve/disable returns 409 RULE_NOT_OURS when the rule isn't ours", async () => {
    vi.mocked(tailscaleService.disableServe).mockRejectedValue(new TailscaleRuleNotOursError(9999));
    const res = await app.inject({ method: "POST", url: "/tailscale/serve/disable" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "RULE_NOT_OURS", actualPort: 9999 });
  });

  it("POST /tailscale/serve/disable returns enabled:false on success", async () => {
    vi.mocked(tailscaleService.disableServe).mockResolvedValue();
    const res = await app.inject({ method: "POST", url: "/tailscale/serve/disable" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
  });

  it("POST /tailscale/up returns the run result on success", async () => {
    vi.mocked(tailscaleService.runUp).mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      loginUrl: null,
    });
    const res = await app.inject({ method: "POST", url: "/tailscale/up" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      loginUrl: null,
    });
  });

  it("POST /tailscale/up returns 200 with the NeedsLogin shape (timedOut + loginUrl)", async () => {
    vi.mocked(tailscaleService.runUp).mockResolvedValue({
      stdout: "",
      stderr: "To authenticate, visit:\nhttps://login.tailscale.com/a/abc123",
      exitCode: -1,
      timedOut: true,
      loginUrl: "https://login.tailscale.com/a/abc123",
    });
    const res = await app.inject({ method: "POST", url: "/tailscale/up" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      stdout: "",
      stderr: "To authenticate, visit:\nhttps://login.tailscale.com/a/abc123",
      exitCode: -1,
      timedOut: true,
      loginUrl: "https://login.tailscale.com/a/abc123",
    });
  });

  it("POST /tailscale/up returns 403 DESKTOP_ONLY for a browser-scoped token", async () => {
    const authState: AuthState = {
      daemonToken: "test-secret",
      browserEpoch: 0,
      revokedTokenIds: new Set(),
      mintedBrowserSessions: new Map(),
    };
    const browserToken = mintToken("browser", authState);
    const authed = await (await import("../server.js")).buildServer({
      authState,
      port,
    });
    try {
      const res = await authed.inject({
        method: "POST",
        url: "/tailscale/up",
        headers: { authorization: `Bearer ${browserToken}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "DESKTOP_ONLY" });
    } finally {
      await authed.close();
    }
  });

  it("POST /tailscale/up returns 500 when runUp throws", async () => {
    vi.mocked(tailscaleService.runUp).mockRejectedValue(new Error("tailscale not found"));
    const res = await app.inject({ method: "POST", url: "/tailscale/up" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "tailscale not found" });
  });

  it("GET /tailscale/qr returns 409 when serve is not active", async () => {
    vi.mocked(tailscaleService.getStatus).mockResolvedValue({
      state: "connected_no_serve",
      httpsUrl: "https://machine.tail0123.ts.net",
      setupCommand: "tailscale serve ...",
    } as TailscaleStatus);
    const res = await app.inject({ method: "GET", url: "/tailscale/qr" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "TAILSCALE_SERVE_NOT_ACTIVE" });
  });

  it("GET /tailscale/qr returns a 30s one-time code URL when serve is active", async () => {
    vi.mocked(tailscaleService.getStatus).mockResolvedValue({
      state: "serve_active",
      httpsUrl: "https://machine.tail0123.ts.net",
    });
    const res = await app.inject({ method: "GET", url: "/tailscale/qr" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { qrUrl: string; expiresAt: number };
    expect(body.qrUrl.startsWith("https://machine.tail0123.ts.net/mobile-auth?code=")).toBe(true);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(30_000);
  });
});
