import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { registerHealthRoute } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerWorktreeRoutes } from "./routes/worktrees.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerModeRoutes } from "./routes/modes.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerFsRoutes } from "./routes/fs.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerWSEndpoint } from "./ws/server.js";
import { COOKIE_NAME, validateSessionCookie } from "./auth.js";

const here = dirname(fileURLToPath(import.meta.url));

// Routes exempt from authentication.
// GET /ws is intentionally exempt here — the WS handler owns its own auth
// and sends close code 4401 so the browser client can distinguish an
// auth failure from a network drop (code 1006). If we rejected at the HTTP
// level the upgrade never completes and the client can't read the close code.
const AUTH_EXEMPT = new Set([
  "GET /health",
  "GET /ws",
  "POST /auth/login",
  "POST /auth/logout",
  "GET /auth/check",
]);

function readVersion(): string {
  try {
    // dist/daemon/server.js → ../../package.json when compiled
    const pkgPath = join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    return pkg.version;
  } catch {
    try {
      // src/daemon/server.ts → ../../package.json (ts-node / vitest)
      const pkgPath = join(here, "..", "..", "..", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
      return pkg.version;
    } catch {
      return "0.0.0";
    }
  }
}

export interface BuildServerOptions {
  port?: number;
  logger?: boolean;
  /** Daemon token for auth. When omitted all requests are allowed (dev/test). */
  token?: string;
  /**
   * Dev escape hatch (VST_NO_AUTH): disable the auth guard entirely so the web
   * UI loads with no login. The auth routes are still served as no-op stubs so
   * GET /auth/check returns ok (the frontend gates on it) instead of 404.
   * NEVER enable on a network-exposed daemon without another access control.
   */
  noAuth?: boolean;
}

export async function buildServer(opts: BuildServerOptions = {}) {
  const startedAt = Date.now();
  const version = readVersion();
  const { token, noAuth } = opts;

  const app = Fastify({
    logger: opts.logger ?? false,
  });

  // Expose the version so routes can read it
  (app as typeof app & { vstVersion: string }).vstVersion = version;

  // ── Plugins (order matters: cookie before hooks, cors before routes) ────────

  // Parse Cookie headers so req.cookies is available in hooks and routes
  await app.register(fastifyCookie);

  // CORS — reflect the request origin (any origin) and allow credentials.
  // CSRF defense lives at the cookie layer: HMAC-signed session token +
  // SameSite=Strict. An origin allowlist here would block legitimate LAN /
  // Tailscale / reverse-proxy access without adding meaningful protection,
  // since unauthenticated origins still can't forge a valid cookie.
  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  // ── Auth guard ───────────────────────────────────────────────────────────────
  if (token && !noAuth) {
    app.addHook("onRequest", async (req, reply) => {
      const key = `${req.method} ${req.routeOptions?.url ?? new URL(req.url, "http://x").pathname}`;
      if (AUTH_EXEMPT.has(key)) return;

      // Path 1 — CLI: Authorization: Bearer <daemonToken>
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        const provided = Buffer.from(authHeader.slice(7));
        const expected = Buffer.from(token);
        if (provided.length === expected.length) {
          try {
            if (timingSafeEqual(provided, expected)) return;
          } catch { /* fall through */ }
        }
        return reply.status(401).send({ error: "Invalid token." });
      }

      // Path 2 — Browser: vst-session cookie
      const cookies = (req as typeof req & { cookies?: Record<string, string> }).cookies ?? {};
      const sessionCookie = cookies[COOKIE_NAME] ?? "";
      if (validateSessionCookie(sessionCookie, token)) return;

      return reply.status(401).send({ error: "Not authenticated." });
    });
  }

  // ── Routes ───────────────────────────────────────────────────────────────────
  registerHealthRoute(app, startedAt);
  if (noAuth) {
    // No-auth dev mode: stub the auth routes so the web UI's /auth/check gate
    // passes (returning 404 would strand it on the LoginScreen with no working
    // login). The guard above is skipped, so these are purely cosmetic.
    app.get("/auth/check", async (_req, reply) => reply.send({ ok: true }));
    app.post("/auth/login", async (_req, reply) => reply.send({ ok: true }));
    app.post("/auth/logout", async (_req, reply) => reply.send({ ok: true }));
  } else if (token) {
    registerAuthRoutes(app, token);
  }
  registerProjectRoutes(app);
  registerWorktreeRoutes(app);
  registerSessionRoutes(app);
  registerModeRoutes(app);
  registerSettingsRoutes(app);
  registerFsRoutes(app);
  await registerWSEndpoint(app, noAuth ? undefined : token);

  return app;
}
