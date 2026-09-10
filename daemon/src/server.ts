import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { registerHealthRoute } from "./routes/health.js";
import { registerOpenRoute } from "./routes/open.js";
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
import { setDaemonPort } from "./services/daemonPort.js";
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
    // Honour X-Forwarded-For ONLY when the TCP peer is itself loopback (the Vite
    // dev proxy). The daemon binds 0.0.0.0, so `trustProxy: true` would let any
    // LAN client forge `X-Forwarded-For: 127.0.0.1` and hit the loopback auth
    // bypass. proxy-addr walks the chain right-to-left and stops at the first
    // untrusted hop, so a forged leading entry relayed through Vite is ignored
    // as well. cloudflared connections are identified by CF-Connecting-IP and
    // the loopback bypass is skipped for them before the IP is consulted.
    trustProxy: "loopback",
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
  // allowedHeaders must be explicit: @fastify/cors does not reliably reflect
  // Authorization in preflights for uncached DELETE/PATCH URLs (each session id
  // is unique, so the preflight cache never hits), causing WebKit "Load failed".
  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
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
          // Accept any localhost origin (any port) — the loopback check above
          // already constrains us to code running on this machine, so port
          // specificity adds nothing. Also accept Tauri WebView origins
          // (tauri://localhost, http://tauri.localhost) used by the desktop shell.
          const isLocalhostOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
          const isTauriOrigin = origin === "tauri://localhost" ||
            /^https?:\/\/tauri\.localhost$/.test(origin);
          if (!isLocalhostOrigin && !isTauriOrigin) {
            return reply.status(403).send({ error: "Forbidden." });
          }
        }
        // Trusted loopback (CSRF check passed) — always allowed, but if a token IS
        // present (e.g. Tauri Bearer or browser cookie from Vite proxy), verify it
        // and attach authPayload so routes can distinguish caller scope ('tauri' vs
        // 'browser') rather than treating all loopback callers as desktop.
        const authHeader = req.headers.authorization;
        const cookies = (req as typeof req & { cookies?: Record<string, string> }).cookies ?? {};
        const rawToken = authHeader?.startsWith("Bearer ")
          ? authHeader.slice(7)
          : (cookies[COOKIE_NAME] ?? "");
        if (rawToken && authState) {
          const result = verifyToken(rawToken, authState);
          if (result.ok) {
            (req as typeof req & { authPayload?: TokenPayload }).authPayload = result.payload;
          }
        }
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
    app.post("/auth/logout", async (_req, reply) => reply.send({ ok: true }));
    app.post("/auth/revoke-browser", async (_req, reply) => reply.send({ ok: true, browserEpoch: 0 }));
  } else if (authState) {
    registerAuthRoutes(app, persistEpoch ?? (() => Promise.resolve()));
  }
  registerMobileAuthRoutes(app, { authState, noAuth, port: opts.port });
  registerOpenRoute(app);
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

  // Publish the bound port process-wide the moment we start listening, so code
  // with no Fastify handle (WS handlers, timers, lifecycle notifications) can
  // put a REACHABLE VST_DAEMON_URL in an agent's spawn env. Covers ephemeral
  // ports (`listen({ port: 0 })`) too, where the requested port isn't the real one.
  app.addHook("onListen", async () => {
    const addr = app.server.address() as { port?: number } | null;
    if (addr?.port) setDaemonPort(addr.port);
  });

  return app;
}
