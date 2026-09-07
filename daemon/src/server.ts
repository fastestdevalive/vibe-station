import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { registerHealthRoute } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerWorktreeRoutes } from "./routes/worktrees.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerModeRoutes } from "./routes/modes.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSkillsRoutes } from "./routes/skills.js";
import { registerOrderedListsRoutes } from "./routes/orderedLists.js";
import { registerFsRoutes } from "./routes/fs.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMobileAuthRoutes } from "./routes/mobileAuth.js";
import { registerWSEndpoint } from "./ws/server.js";
import { COOKIE_NAME, verifyToken } from "./auth.js";
import type { AuthState } from "./state/auth-state.js";
import type { TokenPayload } from "./types.js";

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
  /** In-memory auth state (daemonToken + browserEpoch). When omitted all requests are allowed (dev/test). */
  authState?: AuthState;
  /**
   * Dev escape hatch (VST_NO_AUTH): disable the auth guard entirely so the web
   * UI loads with no login. The auth routes are still served as no-op stubs so
   * GET /auth/check returns ok (the frontend gates on it) instead of 404.
   * NEVER enable on a network-exposed daemon without another access control.
   */
  noAuth?: boolean;
  /** Override the auto-detected web-ui/dist path (used in tests). */
  distPath?: string;
  /**
   * Callback to persist the current browserEpoch to config.json.
   * Passed to auth routes so they can flush epoch bumps without importing main.ts.
   */
  persistEpoch?: () => Promise<void>;
}

export async function buildServer(opts: BuildServerOptions = {}) {
  const startedAt = Date.now();
  const version = readVersion();
  const { authState, noAuth, persistEpoch } = opts;
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
  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  // ── Auth guard ───────────────────────────────────────────────────────────────
  if (authState && !noAuth) {
    app.addHook("onRequest", async (req, reply) => {
      const key = `${req.method} ${req.routeOptions?.url ?? new URL(req.url, "http://x").pathname}`;

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
      //
      // M2: The CSRF/Origin check is applied BEFORE the AUTH_EXEMPT early-return
      // so that /auth/login and /auth/logout cannot be CSRF'd from another loopback origin.
      const viaTunnel = !!req.headers["cf-connecting-ip"];
      const ip = req.ip;
      if (!viaTunnel && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1")) {
        // CSRF guard: if Origin header present it must match the daemon's own origin.
        // CLI tools and curl don't send Origin — they pass through unchanged.
        // A browser tab on a DIFFERENT origin (cross-site request) sends Origin and
        // is rejected here. Vite dev proxy forwards same-origin requests without
        // an Origin header for GET, so this does not break the dev workflow for
        // GET-heavy routes. POST requests from Vite dev (port 5173) carry
        // Origin: http://localhost:5173 which this check rejects — see Open Question 2.
        const origin = req.headers.origin;
        if (origin) {
          const allowed = [
            `http://localhost:${opts.port}`,
            `http://127.0.0.1:${opts.port}`,
            // Vite dev server proxies POST requests with its own origin header.
            // Only allowed in non-production environments.
            ...(process.env.NODE_ENV !== "production"
              ? ["http://localhost:5173", "http://127.0.0.1:5173"]
              : []),
          ];
          if (!allowed.includes(origin)) {
            return reply.status(403).send({ error: "Forbidden." });
          }
        }
        // Trusted loopback (CSRF check passed) — no credentials needed for any route.
        return;
      }

      // Static plugin catch-all (/*) and SPA fallback (no routeOptions) serve the
      // app bundle — exempt so the browser can bootstrap before showing login.
      const routeUrl = req.routeOptions?.url;
      if (!routeUrl || routeUrl === "/*") return;

      // Routes exempt from credential check (but still subject to CSRF check above
      // when accessed from loopback).
      if (AUTH_EXEMPT.has(key)) return;

      // Extract credential: Bearer token or cookie
      const authHeader = req.headers.authorization;
      const cookies = (req as typeof req & { cookies?: Record<string, string> }).cookies ?? {};
      const rawToken = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : (cookies[COOKIE_NAME] ?? "");

      const result = verifyToken(rawToken, authState);
      if (!result.ok) {
        return reply.status(401).send({ error: "Not authenticated." });
      }
      // Attach payload to request for downstream use (e.g. /auth/check)
      (req as typeof req & { authPayload?: TokenPayload }).authPayload = result.payload;
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
    app.post("/auth/revoke-browser", async (_req, reply) => reply.send({ ok: true, browserEpoch: 0 }));
  } else if (authState) {
    registerAuthRoutes(app, persistEpoch ?? (() => Promise.resolve()));
  }
  registerMobileAuthRoutes(app, { authState, noAuth, port: opts.port });
  registerProjectRoutes(app);
  registerWorktreeRoutes(app);
  registerSessionRoutes(app);
  registerAttachmentRoutes(app);
  registerModeRoutes(app);
  registerSettingsRoutes(app);
  registerSkillsRoutes(app);
  registerOrderedListsRoutes(app);
  registerFsRoutes(app);

  if (distPath) {
    await app.register(fastifyStatic, { root: distPath, prefix: "/" });
    app.setNotFoundHandler(async (_req, reply) => {
      return reply.sendFile("index.html");
    });
  }

  await registerWSEndpoint(app, noAuth ? undefined : authState);

  return app;
}
