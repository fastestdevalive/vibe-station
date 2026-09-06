import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

let tempDir: string;
let tunnelState: { enabled: boolean; tunnelUrl: string | null; startedAt: number | null };

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  return {
    vstHome: () => tempDir,
    dbPath: () => pathJoin(tempDir, "vibe-station.db"),
    daemonLogPath: () => pathJoin(tempDir, "logs", "daemon.log"),
    cloudflaredLogPath: () => pathJoin(tempDir, "logs", "cloudflared.log"),
  };
});

// Route-level tests don't need a real cloudflared process — only a
// controllable getState() to simulate "tunnel is live at this URL".
// enable/disable are stubbed too so /auth/tunnel/enable|disable stay
// exercisable without spawning anything.
vi.mock("../services/cloudflared.js", () => ({
  getState: () => tunnelState,
  enable: vi.fn(async () => ({ tunnelUrl: tunnelState.tunnelUrl ?? "https://mock.trycloudflare.com" })),
  disable: vi.fn(() => {
    tunnelState = { enabled: false, tunnelUrl: null, startedAt: null };
  }),
}));

const BEARER = { authorization: "Bearer test-token" };
const TUNNEL_IP = { "cf-connecting-ip": "1.2.3.4" };

async function importBuildServer() {
  const mod = await import("../server.js");
  return mod.buildServer;
}

describe("mobileAuth routes — tunnel-persistence", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-mobileauth-test-"));
    tunnelState = { enabled: false, tunnelUrl: null, startedAt: null };
    vi.resetModules();
  });

  afterEach(async () => {
    await app?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("3.T1 — a tunnel-origin /mobile-auth redemption stamps the session's tunnelUrl to the live URL", async () => {
    tunnelState = { enabled: true, tunnelUrl: "https://live.trycloudflare.com", startedAt: 1 };
    const buildServer = await importBuildServer();
    app = await buildServer({ token: "test-token" });

    // Mint a tunnel-origin QR code the same way /auth/mobile-qr would, but
    // directly via the route to keep this test focused on the redemption path.
    const qrRes = await app.inject({ method: "POST", url: "/auth/mobile-qr", headers: BEARER });
    expect(qrRes.statusCode).toBe(200);
    const { qrUrl } = qrRes.json() as { qrUrl: string };
    const code = new URL(qrUrl).searchParams.get("code")!;

    const redeemRes = await app.inject({
      method: "GET",
      url: `/mobile-auth?code=${code}`,
      headers: TUNNEL_IP,
    });
    expect(redeemRes.statusCode).toBe(200);

    const sessionStore = await import("../state/auth-session-store.js");
    const rows = sessionStore.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tunnelUrl).toBe("https://live.trycloudflare.com");
  });

  it("3.T2 — a local-network /mobile-auth redemption (no cf-connecting-ip) stamps tunnelUrl: null", async () => {
    tunnelState = { enabled: true, tunnelUrl: "https://live.trycloudflare.com", startedAt: 1 };
    const buildServer = await importBuildServer();
    app = await buildServer({ token: "test-token" });

    const qrRes = await app.inject({ method: "POST", url: "/auth/local-qr", headers: BEARER });
    expect(qrRes.statusCode).toBe(200);
    const { qrUrl } = qrRes.json() as { qrUrl: string };
    const code = new URL(qrUrl).searchParams.get("code")!;

    const redeemRes = await app.inject({ method: "GET", url: `/mobile-auth?code=${code}` });
    expect(redeemRes.statusCode).toBe(200);

    const sessionStore = await import("../state/auth-session-store.js");
    const rows = sessionStore.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tunnelUrl).toBeNull();
  });

  it("3.T3 — GET /auth/sessions computes tunnelInvalidated/tunnelLive server-side and omits raw tunnelUrl", async () => {
    tunnelState = { enabled: true, tunnelUrl: "https://current.trycloudflare.com", startedAt: 1 };
    const buildServer = await importBuildServer();
    app = await buildServer({ token: "test-token" });

    const sessionStore = await import("../state/auth-session-store.js");
    sessionStore.issue("nonce-live", { createdVia: "qr", tunnelUrl: "https://current.trycloudflare.com" });
    sessionStore.issue("nonce-stale", { createdVia: "qr", tunnelUrl: "https://old.trycloudflare.com" });
    sessionStore.issue("nonce-password", { createdVia: "password" });

    const res = await app.inject({ method: "GET", url: "/auth/sessions", headers: BEARER });
    expect(res.statusCode).toBe(200);
    const { sessions } = res.json() as {
      sessions: Array<{ nonce: string; tunnelInvalidated: boolean; tunnelLive: boolean; tunnelUrl?: string }>;
    };

    const byNonce = Object.fromEntries(sessions.map((s) => [s.nonce, s]));
    expect(byNonce["nonce-live"]).toMatchObject({ tunnelInvalidated: false, tunnelLive: true });
    expect(byNonce["nonce-stale"]).toMatchObject({ tunnelInvalidated: true, tunnelLive: false });
    expect(byNonce["nonce-password"]).toMatchObject({ tunnelInvalidated: false, tunnelLive: false });
    for (const s of sessions) expect(s.tunnelUrl).toBeUndefined();
  });

  it("3.T4 — POST /auth/tunnel/disable revokes only live-tunnel sessions and closes their connections", async () => {
    tunnelState = { enabled: true, tunnelUrl: "https://current.trycloudflare.com", startedAt: 1 };
    const buildServer = await importBuildServer();
    app = await buildServer({ token: "test-token" });

    const sessionStore = await import("../state/auth-session-store.js");
    const broadcaster = await import("../broadcaster.js");
    const closeSpy = vi.spyOn(broadcaster, "closeConnectionsByNonce");

    sessionStore.issue("nonce-live-1", { createdVia: "qr", tunnelUrl: "https://current.trycloudflare.com" });
    sessionStore.issue("nonce-live-2", { createdVia: "qr", tunnelUrl: "https://current.trycloudflare.com" });
    sessionStore.issue("nonce-password", { createdVia: "password" });

    const res = await app.inject({ method: "POST", url: "/auth/tunnel/disable", headers: BEARER });
    expect(res.statusCode).toBe(200);

    const remaining = sessionStore.list().map((r) => r.nonce);
    expect(remaining).not.toContain("nonce-live-1");
    expect(remaining).not.toContain("nonce-live-2");
    expect(remaining).toContain("nonce-password");

    expect(closeSpy).toHaveBeenCalledWith("nonce-live-1", 4403, "Tunnel disabled");
    expect(closeSpy).toHaveBeenCalledWith("nonce-live-2", 4403, "Tunnel disabled");
    expect(closeSpy).not.toHaveBeenCalledWith("nonce-password", expect.anything(), expect.anything());
  });

  it("3.T5 — code-redemption regressions: expired/consumed code returns 410, missing code returns 400", async () => {
    const buildServer = await importBuildServer();
    app = await buildServer({ token: "test-token" });

    const missing = await app.inject({ method: "GET", url: "/mobile-auth" });
    expect(missing.statusCode).toBe(400);

    const bogus = await app.inject({ method: "GET", url: "/mobile-auth?code=does-not-exist" });
    expect(bogus.statusCode).toBe(410);
  });

  it("3.T5 — a tunnel-minted code cannot be redeemed via the local-network path (origin mismatch → 410)", async () => {
    tunnelState = { enabled: true, tunnelUrl: "https://live.trycloudflare.com", startedAt: 1 };
    const buildServer = await importBuildServer();
    app = await buildServer({ token: "test-token" });

    const qrRes = await app.inject({ method: "POST", url: "/auth/mobile-qr", headers: BEARER });
    const { qrUrl } = qrRes.json() as { qrUrl: string };
    const code = new URL(qrUrl).searchParams.get("code")!;

    // Redeem WITHOUT the cf-connecting-ip header — origin mismatch.
    const res = await app.inject({ method: "GET", url: `/mobile-auth?code=${code}` });
    expect(res.statusCode).toBe(410);
  });
});
