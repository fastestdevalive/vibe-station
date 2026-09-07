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

const TUNNEL_IP = { "cf-connecting-ip": "1.2.3.4" };

/**
 * Build a server wired to a real in-memory auth state. The stateless auth
 * redesign replaced `buildServer({ token })` with an `authState` holding the
 * daemonToken + browserEpoch; `/mobile-auth` mints a browser-scope token off
 * it, and returns 503 when it's absent.
 */
async function importDeps() {
  const server = await import("../server.js");
  const authStateMod = await import("../state/auth-state.js");
  authStateMod.loadAuthState("test-daemon-token", 0);
  return { buildServer: server.buildServer, authState: authStateMod.getAuthState() };
}

describe("mobileAuth routes — QR code redemption", () => {
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

  it("a tunnel-origin /mobile-auth redemption issues a browser session cookie", async () => {
    tunnelState = { enabled: true, tunnelUrl: "https://live.trycloudflare.com", startedAt: 1 };
    const { buildServer, authState } = await importDeps();
    app = await buildServer({ authState });

    const qrRes = await app.inject({ method: "POST", url: "/auth/mobile-qr" });
    expect(qrRes.statusCode).toBe(200);
    const { qrUrl } = qrRes.json() as { qrUrl: string };
    expect(qrUrl.startsWith("https://live.trycloudflare.com/mobile-auth?code=")).toBe(true);
    const code = new URL(qrUrl).searchParams.get("code")!;

    const redeemRes = await app.inject({
      method: "GET",
      url: `/mobile-auth?code=${code}`,
      headers: TUNNEL_IP,
    });
    expect(redeemRes.statusCode).toBe(200);
    // Tunnel origin is HTTPS, so the cookie must carry `Secure`.
    expect(redeemRes.headers["set-cookie"]).toMatch(/Secure/);
  });

  it("a local-network redemption issues a cookie WITHOUT Secure (plain http origin)", async () => {
    const { buildServer, authState } = await importDeps();
    app = await buildServer({ authState });

    const qrRes = await app.inject({ method: "POST", url: "/auth/local-qr" });
    expect(qrRes.statusCode).toBe(200);
    const { qrUrl } = qrRes.json() as { qrUrl: string };
    const code = new URL(qrUrl).searchParams.get("code")!;

    const redeemRes = await app.inject({ method: "GET", url: `/mobile-auth?code=${code}` });
    expect(redeemRes.statusCode).toBe(200);
    // Browsers silently drop a Secure cookie on an insecure origin, which would
    // make local-QR login appear to succeed then bounce back to the login screen.
    expect(redeemRes.headers["set-cookie"]).not.toMatch(/Secure/);
  });

  it("POST /auth/mobile-qr is 409 when the tunnel is not enabled", async () => {
    const { buildServer, authState } = await importDeps();
    app = await buildServer({ authState });

    const res = await app.inject({ method: "POST", url: "/auth/mobile-qr" });
    expect(res.statusCode).toBe(409);
  });

  it("POST /auth/tunnel/disable invalidates tunnel-minted codes but not local ones", async () => {
    tunnelState = { enabled: true, tunnelUrl: "https://current.trycloudflare.com", startedAt: 1 };
    const { buildServer, authState } = await importDeps();
    app = await buildServer({ authState });

    const tunnelCode = new URL(
      (await app.inject({ method: "POST", url: "/auth/mobile-qr" })).json<{ qrUrl: string }>().qrUrl,
    ).searchParams.get("code")!;
    const localCode = new URL(
      (await app.inject({ method: "POST", url: "/auth/local-qr" })).json<{ qrUrl: string }>().qrUrl,
    ).searchParams.get("code")!;

    const res = await app.inject({ method: "POST", url: "/auth/tunnel/disable" });
    expect(res.statusCode).toBe(200);

    // The tunnel-minted code is gone…
    const tunnelRedeem = await app.inject({
      method: "GET",
      url: `/mobile-auth?code=${tunnelCode}`,
      headers: TUNNEL_IP,
    });
    expect(tunnelRedeem.statusCode).toBe(410);

    // …while a local-network QR shown at the same time keeps working.
    const localRedeem = await app.inject({ method: "GET", url: `/mobile-auth?code=${localCode}` });
    expect(localRedeem.statusCode).toBe(200);
  });

  it("code-redemption regressions: expired/consumed code returns 410, missing code returns 400", async () => {
    const { buildServer, authState } = await importDeps();
    app = await buildServer({ authState });

    const missing = await app.inject({ method: "GET", url: "/mobile-auth" });
    expect(missing.statusCode).toBe(400);

    const bogus = await app.inject({ method: "GET", url: "/mobile-auth?code=does-not-exist" });
    expect(bogus.statusCode).toBe(410);
  });

  it("a tunnel-minted code cannot be redeemed via the local-network path (origin mismatch → 410)", async () => {
    tunnelState = { enabled: true, tunnelUrl: "https://live.trycloudflare.com", startedAt: 1 };
    const { buildServer, authState } = await importDeps();
    app = await buildServer({ authState });

    const qrRes = await app.inject({ method: "POST", url: "/auth/mobile-qr" });
    const { qrUrl } = qrRes.json() as { qrUrl: string };
    const code = new URL(qrUrl).searchParams.get("code")!;

    // Redeem WITHOUT the cf-connecting-ip header — origin mismatch.
    const res = await app.inject({ method: "GET", url: `/mobile-auth?code=${code}` });
    expect(res.statusCode).toBe(410);
  });

  it("a single-use code cannot be redeemed twice", async () => {
    const { buildServer, authState } = await importDeps();
    app = await buildServer({ authState });

    const { qrUrl } = (await app.inject({ method: "POST", url: "/auth/local-qr" })).json<{ qrUrl: string }>();
    const code = new URL(qrUrl).searchParams.get("code")!;

    expect((await app.inject({ method: "GET", url: `/mobile-auth?code=${code}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/mobile-auth?code=${code}` })).statusCode).toBe(410);
  });
});
