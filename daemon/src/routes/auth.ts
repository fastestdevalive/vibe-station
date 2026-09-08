import type { FastifyInstance } from "fastify";
import { COOKIE_NAME } from "../auth.js";
import { bumpBrowserEpoch, revokeTokenId } from "../state/auth-state.js";
import { closeConnectionsByTokenId, closeConnectionsByScope, getRemoteSessions } from "../broadcaster.js";
import type { TokenPayload } from "../types.js";

/**
 * Parse a raw Cookie header string and return the value for a given cookie name.
 * Mirrors the helper in ws/server.ts — kept local so the route has no dependency
 * on the WS layer.
 */
function parseCookieValue(cookieHeader: string, name: string): string {
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx).trim();
    const v = part.slice(eqIdx + 1).trim();
    if (k === name) return v;
  }
  return "";
}

/**
 * Derive the caller's tokenId from the raw token on the request (cookie or
 * Authorization header). A token is `<tokenId>.<signature>`, so the id is
 * everything before the final dot — the same derivation used in ws/server.ts.
 * Returns undefined when the request carries no token (e.g. desktop/loopback).
 */
function currentTokenIdOf(req: { headers: Record<string, unknown> }): string | undefined {
  const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const cookieHeader = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const token = bearer || parseCookieValue(cookieHeader, COOKIE_NAME);
  if (!token) return undefined;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return token.slice(0, dot);
}

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
    // isDesktop: true for the Tauri desktop app (scope='tauri') or a plain loopback
    // caller with no token (CLI tools, etc.). Browser/mobile sessions have a verified
    // token with scope='browser'/'mobile' and are not desktop.
    const isDesktop = !authPayload || authPayload.scope === "tauri";
    // currentScope: the caller's token scope; loopback-with-no-token is treated as 'tauri'.
    const currentScope: string = authPayload?.scope ?? "tauri";
    // currentTokenId: lets a browser/mobile viewer find *itself* in the sessions
    // list (it has a real entry there) and badge it as "this session". Undefined
    // for desktop/loopback callers, which carry no token and have no list entry.
    const currentTokenId = currentTokenIdOf(req as unknown as { headers: Record<string, unknown> });
    return reply.send({ sessions: getRemoteSessions(), isDesktop, currentScope, currentTokenId });
  });

  // POST /auth/sessions/:id/revoke — revoke a remote session by tokenId.
  // Desktop (loopback, scope=null or 'tauri') only — browser/mobile sessions cannot revoke.
  app.post("/auth/sessions/:id/revoke", async (req, reply) => {
    const authPayload = (req as typeof req & { authPayload?: TokenPayload }).authPayload;
    if (authPayload && authPayload.scope !== "tauri") {
      return reply.status(403).send({ error: "DESKTOP_ONLY" });
    }
    const { id } = req.params as { id: string };
    revokeTokenId(id);
    const found = closeConnectionsByTokenId(id, 4403, "Session revoked");
    if (!found) return reply.status(404).send({ error: "Session not found." });
    return reply.send({ ok: true });
  });

  // POST /auth/revoke-browser — bump browserEpoch to invalidate all browser tokens.
  // Desktop (loopback, scope=null or 'tauri') only.
  app.post("/auth/revoke-browser", async (req, reply) => {
    const authPayload = (req as typeof req & { authPayload?: TokenPayload }).authPayload;
    if (authPayload && authPayload.scope !== "tauri") {
      return reply.status(403).send({ error: "DESKTOP_ONLY" });
    }
    const newEpoch = await bumpBrowserEpoch(persistEpoch);
    closeConnectionsByScope("browser", 4403, "Session revoked");
    return reply.send({ ok: true, browserEpoch: newEpoch });
  });
}
