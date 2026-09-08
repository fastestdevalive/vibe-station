import type { FastifyInstance } from "fastify";
import { COOKIE_NAME } from "../auth.js";
import { bumpBrowserEpoch, revokeTokenId } from "../state/auth-state.js";
import { closeConnectionsByTokenId, closeConnectionsByScope, getRemoteSessions } from "../broadcaster.js";
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

  // GET /auth/sessions — list currently connected remote (browser/mobile) sessions.
  // Available to all session types. Includes isDesktop so the UI can adapt its
  // display (e.g. hide revoke buttons for non-desktop viewers).
  app.get("/auth/sessions", async (req, reply) => {
    const authPayload = (req as typeof req & { authPayload?: TokenPayload }).authPayload;
    // Loopback callers have no authPayload (auth guard is bypassed for them).
    const isDesktop = !authPayload;
    return reply.send({ sessions: getRemoteSessions(), isDesktop });
  });

  // POST /auth/sessions/:id/revoke — revoke a remote session by tokenId.
  // Desktop (loopback) only — browser sessions cannot revoke other sessions.
  app.post("/auth/sessions/:id/revoke", async (req, reply) => {
    const authPayload = (req as typeof req & { authPayload?: TokenPayload }).authPayload;
    if (authPayload) {
      return reply.status(403).send({ error: "DESKTOP_ONLY" });
    }
    const { id } = req.params as { id: string };
    revokeTokenId(id);
    const found = closeConnectionsByTokenId(id, 4403, "Session revoked");
    if (!found) return reply.status(404).send({ error: "Session not found." });
    return reply.send({ ok: true });
  });

  // POST /auth/revoke-browser — bump browserEpoch to invalidate all browser tokens.
  // Desktop (loopback) only.
  app.post("/auth/revoke-browser", async (req, reply) => {
    const authPayload = (req as typeof req & { authPayload?: TokenPayload }).authPayload;
    if (authPayload) {
      return reply.status(403).send({ error: "DESKTOP_ONLY" });
    }
    const newEpoch = await bumpBrowserEpoch(persistEpoch);
    closeConnectionsByScope("browser", 4403, "Session revoked");
    return reply.send({ ok: true, browserEpoch: newEpoch });
  });
}
