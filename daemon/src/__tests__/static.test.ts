import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  const { tmpdir: osTmpdir } = await import("node:os");
  const base = pathJoin(osTmpdir(), "vst-static-test");
  return {
    vstHome: () => base,
    configPath: () => pathJoin(base, "config.json"),
    dbPath: () => pathJoin(base, "vibe-station.db"),
    projectDir: (id: string) => pathJoin(base, "projects", id),
    manifestPath: (id: string) => pathJoin(base, "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(base, "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wt: string) => pathJoin(base, "projects", id, "worktrees", wt),
    modesPath: () => pathJoin(base, "modes.json"),
    daemonLogPath: () => pathJoin(base, "logs", "daemon.log"),
    cleanupSessionDataDir: () => {},
    sessionDataDir: (p: string, w: string, s: string) =>
      pathJoin(base, "projects", p, "session-data", w, s),
    systemPromptPath: (p: string, w: string, s: string) =>
      pathJoin(base, "projects", p, "session-data", w, s, "system-prompt.md"),
    opencodeConfigPath: (p: string, w: string, s: string) =>
      pathJoin(base, "projects", p, "session-data", w, s, "opencode-config.json"),
    directSessionDataDir: (p: string, s: string) =>
      pathJoin(base, "projects", p, "sessions", s),
    directSystemPromptPath: (p: string, s: string) =>
      pathJoin(base, "projects", p, "sessions", s, "system-prompt.md"),
    directOpencodeConfigPath: (p: string, s: string) =>
      pathJoin(base, "projects", p, "sessions", s, "opencode-config.json"),
    cleanupDirectSessionDataDir: () => {},
  };
});

describe("static file serving", () => {
  let app: FastifyInstance;
  let tempDist: string;

  afterEach(async () => {
    await app?.close();
    if (tempDist) {
      await rm(tempDist, { recursive: true, force: true });
      tempDist = "";
    }
  });

  async function makeDistDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "vst-dist-"));
    await writeFile(join(dir, "index.html"), "<!DOCTYPE html><html><body>app</body></html>");
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "assets", "main.js"), 'console.log("app");');
    return dir;
  }

  it("(a) GET / returns 200 HTML without a session cookie (auth-exempt)", async () => {
    tempDist = await makeDistDir();
    app = await buildServer({ token: "test-token", distPath: tempDist });

    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<!DOCTYPE html>");
    expect(res.headers["content-type"]).toMatch(/html/);
  });

  it("(b) GET /deep/path SPA fallback returns 200 HTML", async () => {
    tempDist = await makeDistDir();
    app = await buildServer({ token: "test-token", distPath: tempDist });

    const res = await app.inject({ method: "GET", url: "/deep/path" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<!DOCTYPE html>");
  });

  it("(c) GET /api/health returns 200 JSON (rewriteUrl strips /api prefix)", async () => {
    app = await buildServer({ token: "test-token" });

    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("(d) GET /api/projects returns 401 (auth enforced on non-exempt API routes)", async () => {
    app = await buildServer({ token: "test-token" });

    // Non-loopback source: loopback is implicitly trusted (see docs/AUTH.md).
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      remoteAddress: "192.0.2.10",
    });
    expect(res.statusCode).toBe(401);
  });

  it("(f) loopback trust does NOT apply to Cloudflare tunnel requests", async () => {
    app = await buildServer({ token: "test-token" });

    // cloudflared dials the daemon on 127.0.0.1, so a tunnel request looks like
    // loopback at the socket level. CF-Connecting-IP must defeat the bypass.
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      remoteAddress: "127.0.0.1",
      headers: { "cf-connecting-ip": "203.0.113.7" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("(e) daemon starts cleanly with no dist/ dir (no startup error)", async () => {
    // no distPath option — auto-detection finds nothing in test env
    app = await buildServer({ token: "test-token" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});
