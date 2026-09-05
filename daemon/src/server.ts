import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { registerHealthRoute } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerWorktreeRoutes } from "./routes/worktrees.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerModeRoutes } from "./routes/modes.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerOrderedListsRoutes } from "./routes/orderedLists.js";
import { registerFsRoutes } from "./routes/fs.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMobileAuthRoutes } from "./routes/mobileAuth.js";
import { registerWSEndpoint } from "./ws/server.js";
import {
  COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  validateSessionCookie,
  parseSessionCookie,
  generateSessionCookieWithNonce,
} from "./auth.js";
import { isLive, needsBump, bump } from "./state/auth-session-store.js";

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
  "GET /mobile-auth",
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
  /** Override the auto-detected web-ui/dist path (used in tests). */
  distPath?: string;
}

export async function buildServer(opts: BuildServerOptions = {}) {
  const startedAt = Date.now();
  const version = readVersion();
  const { token, noAuth } = opts;
  // distPath: explicit override (tests) or auto-detected from two-try candidates
  const distPath =
    opts.distPath ??
    [join(here, "..", "..", "..", "web-ui", "dist"), join(here, "..", "..", "web-ui", "dist")].find(existsSync);

  const app = Fastify({
    logger: opts.logger ?? false,
    // Mirrors the Vite dev proxy rewrite so /api/auth/login and /auth/login both
    // reach the same route handler regardless of caller (browser, CLI, curl).
    rewriteUrl: (req) => {
      const url = req.url ?? "/";
      if (url.startsWith("/api/")) return url.slice(4);
      if (url === "/api") return "/";
      return url;
    },
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

      // Loopback requests are implicitly trusted — if you can reach 127.0.0.1
      // you are already on the machine. This removes the password prompt for
      // the local desktop user without weakening remote session security.
      //
      // CRITICAL: cloudflared dials the daemon at http://127.0.0.1:<port>, so
      // every tunnel request also arrives from loopback. Without this guard the
      // bypass would hand anyone holding the public tunnel URL full,
      // unauthenticated access to every route. CF-Connecting-IP is set by the
      // Cloudflare edge and cannot be stripped by the remote client; a local
      // process that forges it only loses privileges, never gains them.
      const viaTunnel = !!req.headers["cf-connecting-ip"];
      const ip = req.ip;
      if (!viaTunnel && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1")) return;

      // Static plugin catch-all (/*) and SPA fallback (no routeOptions) serve the
      // app bundle — exempt so the browser can bootstrap before showing login.
      const routeUrl = req.routeOptions?.url;
      if (!routeUrl || routeUrl === "/*") return;

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
      if (!validateSessionCookie(sessionCookie, token)) {
        return reply.status(401).send({ error: "Not authenticated." });
      }

      const parsed = parseSessionCookie(sessionCookie);
      if (!parsed) return reply.status(401).send({ error: "Not authenticated." });
      if (!isLive(parsed.nonce)) return reply.status(401).send({ error: "Session expired or revoked." });

      // Sliding bump: re-issue cookie when lastSeenAt is >1 h ago to reset HMAC TTL clock.
      if (needsBump(parsed.nonce)) {
        bump(parsed.nonce);
        const newCookie = generateSessionCookieWithNonce(token, parsed.nonce);
        const isTunnel = !!req.headers["cf-connecting-ip"];
        const attrs = isTunnel
          ? `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`
          : `HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
        void reply.header("Set-Cookie", `${COOKIE_NAME}=${newCookie}; ${attrs}`);
      }
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
  registerMobileAuthRoutes(app, { token, noAuth, port: opts.port });
  registerProjectRoutes(app);
  registerWorktreeRoutes(app);
  registerSessionRoutes(app);
  registerAttachmentRoutes(app);
  registerModeRoutes(app);
  registerSettingsRoutes(app);
  registerOrderedListsRoutes(app);
  registerFsRoutes(app);

  if (distPath) {
    await app.register(fastifyStatic, { root: distPath, prefix: "/" });
    app.setNotFoundHandler(async (_req, reply) => {
      return reply.sendFile("index.html");
    });
  }

  await registerWSEndpoint(app, noAuth ? undefined : token);

  return app;
}
