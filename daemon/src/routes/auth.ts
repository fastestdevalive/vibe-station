import type { FastifyInstance } from "fastify";
import { COOKIE_NAME } from "../auth.js";
import { bumpBrowserEpoch } from "../state/auth-state.js";
import { closeConnectionsByScope } from "../broadcaster.js";
import type { TokenPayload } from "../types.js";

export function registerAuthRoutes(app: FastifyInstance, persistEpoch: () => Promise<void>): void {
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
