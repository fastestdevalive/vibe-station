import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import fastifyWebsocket from "@fastify/websocket";
import { ClientMessage } from "./protocol.js";
import { WSConnection } from "./connection.js";
import { handleSubscribe, handleUnsubscribe } from "./handlers/subscribe.js";
import { handlePing } from "./handlers/ping.js";
import { handleSessionOpen } from "./handlers/sessionOpen.js";
import { handleSessionClose } from "./handlers/sessionClose.js";
import { handleSessionResize } from "./handlers/sessionResize.js";
import { handleSessionInput } from "./handlers/sessionInput.js";
import { handleFileWatch } from "./handlers/fileWatch.js";
import { handleFileUnwatch } from "./handlers/fileUnwatch.js";
import { handleTreeWatch } from "./handlers/treeWatch.js";
import { handleTreeUnwatch } from "./handlers/treeUnwatch.js";
import { registerConnection, unregisterConnection } from "../broadcaster.js";
import { COOKIE_NAME, validateSessionCookie } from "../auth.js";

/**
 * Parse a raw Cookie header string and return the value for a given cookie name.
 * Reuses @fastify/cookie parsing logic when available; falls back to manual split.
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
 * Authenticate a WebSocket upgrade request.
 * Returns true if allowed, false if rejected (caller should close the socket).
 */
function authenticateWS(req: FastifyRequest, daemonToken: string | undefined): boolean {
  if (!daemonToken) return true; // auth disabled (dev/test)

  // CSRF protection here is the cookie itself: HMAC-signed with the daemon
  // secret + SameSite=Strict means a malicious cross-site page can neither
  // forge nor send the cookie. We deliberately don't gate on Origin — that
  // would block legitimate LAN / Tailscale / reverse-proxy access.

  // Cookie check — validate the vst-session cookie
  const cookieHeader = req.headers.cookie ?? "";
  const sessionCookie = parseCookieValue(cookieHeader, COOKIE_NAME);
  if (validateSessionCookie(sessionCookie, daemonToken)) return true;

  // Bearer fallback — allows CLI tooling to open a WS if needed
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7) === daemonToken;
  }

  return false;
}

/**
 * Register the /ws WebSocket endpoint on the Fastify instance.
 */
export async function registerWSEndpoint(app: FastifyInstance, daemonToken?: string): Promise<void> {
  // Ensure the websocket plugin is registered
  await app.register(fastifyWebsocket);

  app.get("/ws", { websocket: true }, (socket: WebSocket, req) => {
    // Auth gate — reject before registering the connection
    if (!authenticateWS(req, daemonToken)) {
      socket.close(4401, "Unauthorized");
      return;
    }

    const conn = new WSConnection(socket);

    // Register connection for broadcasts
    registerConnection(conn);

    // Monitor buffered amount for backpressure
    const checkBackpressure = () => {
      const buffered = socket.bufferedAmount || 0;
      if (buffered > 1_000_000) {
        console.warn(`[WS] Write buffer exceeded 1MB (${buffered} bytes), closing connection`);
        socket.close(1009, "Message Too Big");
      }
    };

    socket.on("message", async (data: Buffer) => {
      try {
        const text = data.toString("utf8");
        const json = JSON.parse(text);
        const msg = ClientMessage.parse(json);

        // Dispatch based on message type
        switch (msg.type) {
          case "subscribe":
            handleSubscribe(conn, msg);
            break;
          case "unsubscribe":
            handleUnsubscribe(conn, msg);
            break;
          case "ping":
            handlePing(conn);
            break;
          // Phase 2: Output stream handlers
          case "session:open":
            await handleSessionOpen(conn, msg);
            break;
          case "session:close":
            await handleSessionClose(conn, msg);
            break;
          case "session:resize":
            handleSessionResize(conn, msg);
            break;
          // Phase 3: Input handler
          case "session:input":
            handleSessionInput(conn, msg);
            checkBackpressure();
            break;
          // Phase 6-7: File and tree watchers
          case "file:watch":
            handleFileWatch(conn, msg);
            break;
          case "file:unwatch":
            await handleFileUnwatch(conn, msg);
            break;
          case "tree:watch":
            handleTreeWatch(conn, msg);
            break;
          case "tree:unwatch":
            await handleTreeUnwatch(conn, msg);
            break;
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          conn.send({
            type: "system:error",
            message: "Invalid JSON",
          });
        } else if (err instanceof Error && err.message.includes("Zod")) {
          conn.send({
            type: "system:error",
            message: `Invalid message format: ${err.message}`,
          });
        } else {
          console.error("[WS] Message handler error:", err);
          conn.send({
            type: "system:error",
            message: "Internal server error",
          });
        }
      }
    });

    socket.on("close", async () => {
      unregisterConnection(conn);
      await conn.cleanup();
    });

    socket.on("error", (err: Error) => {
      console.error("[WS] Socket error:", err);
    });
  });
}
