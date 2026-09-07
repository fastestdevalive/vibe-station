import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  COOKIE_NAME,
  BROWSER_MAX_AGE_SECONDS,
  checkLoginRateLimit,
  mintToken,
  resetLoginRateLimit,
} from "../auth.js";
import { getAuthState, bumpBrowserEpoch } from "../state/auth-state.js";
import { closeConnectionsByScope } from "../broadcaster.js";
import type { TokenPayload } from "../types.js";

const LoginBody = z.object({ token: z.string().min(1) });

export function registerAuthRoutes(app: FastifyInstance, persistEpoch: () => Promise<void>): void {
  // POST /auth/login — exchange the daemon token for a browser-scope session cookie.
  // Loopback-only (blocked from tunnel by AUTH_EXEMPT exemption + CF-Connecting-IP check).
  app.post("/auth/login", async (req, reply) => {
    // Block password login from tunnel requests (mobile must use QR flow)
    if (req.headers["cf-connecting-ip"]) {
      return reply.status(403).send({ error: "Use QR login on mobile." });
    }

    const ip = req.ip ?? "unknown";
    if (!checkLoginRateLimit(ip)) {
      return reply.status(429).send({ error: "Too many login attempts. Try again in a minute." });
    }

    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid request body." });

    const authState = getAuthState();
    const provided = Buffer.from(parsed.data.token);
    const expected = Buffer.from(authState.daemonToken);
    let valid = false;
    if (provided.length === expected.length) {
      try {
        valid = timingSafeEqual(provided, expected);
      } catch {
        valid = false;
      }
    }
    if (!valid) return reply.status(401).send({ error: "Invalid token." });

    resetLoginRateLimit(ip);
    const cookieValue = mintToken("browser", authState);
    // Secure flag intentionally omitted — the UI runs over plain HTTP on
    // localhost. Adding Secure would silently prevent the browser from sending
    // the cookie over HTTP, causing every post-login request to return 401.
    void reply.header(
      "Set-Cookie",
      `${COOKIE_NAME}=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${BROWSER_MAX_AGE_SECONDS}`,
    );
    return reply.send({ ok: true });
  });

  // POST /auth/logout — clear the cookie (per-device; no epoch bump)
  app.post("/auth/logout", async (_req, reply) => {
    void reply.header(
      "Set-Cookie",
      `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    );
    return reply.send({ ok: true });
  });

  // GET /auth/check — validate current session (used by the web UI on load)
  // The auth guard already ran for non-loopback requests; if we reach here the
  // token is valid (or the request is from loopback where the guard is bypassed).
  app.get("/auth/check", async (req, reply) => {
    const authPayload = (req as typeof req & { authPayload?: TokenPayload }).authPayload;
    // Loopback callers (no authPayload set) always pass — they are on the machine.
    if (!authPayload) return reply.send({ ok: true });
    return reply.send({ ok: true });
  });

  // POST /auth/revoke-browser — bump browserEpoch to invalidate all browser tokens.
  // Any valid token (any scope) can call this. CLI running locally can revoke all
  // remote browser sessions.
  app.post("/auth/revoke-browser", async (_req, reply) => {
    const newEpoch = await bumpBrowserEpoch(persistEpoch);
    closeConnectionsByScope("browser", 4403, "Session revoked");
    return reply.send({ ok: true, browserEpoch: newEpoch });
  });
}
