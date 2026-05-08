import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  checkLoginRateLimit,
  generateSessionCookie,
  resetLoginRateLimit,
  validateSessionCookie,
} from "../auth.js";

const LoginBody = z.object({
  token: z.string().min(1),
});

export function registerAuthRoutes(app: FastifyInstance, daemonToken: string): void {
  // POST /auth/login — exchange the daemon token for a session cookie
  app.post("/auth/login", async (req, reply) => {
    const ip = req.ip ?? "unknown";

    if (!checkLoginRateLimit(ip)) {
      return reply.status(429).send({ error: "Too many login attempts. Try again in a minute." });
    }

    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid request body." });
    }

    // Constant-time comparison to prevent timing attacks
    const provided = Buffer.from(parsed.data.token);
    const expected = Buffer.from(daemonToken);
    let valid = false;
    if (provided.length === expected.length) {
      try {
        const { timingSafeEqual } = await import("node:crypto");
        valid = timingSafeEqual(provided, expected);
      } catch {
        valid = false;
      }
    }

    if (!valid) {
      return reply.status(401).send({ error: "Invalid token." });
    }

    resetLoginRateLimit(ip);

    const cookieValue = generateSessionCookie(daemonToken);
    // Note: Secure flag intentionally omitted — the UI runs over plain HTTP on
    // localhost. Adding Secure would silently prevent the browser from sending
    // the cookie over HTTP, causing every post-login request to return 401.
    void reply.header(
      "Set-Cookie",
      `${COOKIE_NAME}=${cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    );
    return reply.send({ ok: true });
  });

  // POST /auth/logout — clear the session cookie
  app.post("/auth/logout", async (_req, reply) => {
    void reply.header(
      "Set-Cookie",
      `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    );
    return reply.send({ ok: true });
  });

  // GET /auth/check — validate current session (used by the web UI on load)
  app.get("/auth/check", async (req, reply) => {
    const cookies = (req as typeof req & { cookies?: Record<string, string> }).cookies ?? {};
    const sessionCookie = cookies[COOKIE_NAME] ?? "";
    if (!validateSessionCookie(sessionCookie, daemonToken)) {
      return reply.status(401).send({ error: "Not authenticated." });
    }
    return reply.send({ ok: true });
  });
}
