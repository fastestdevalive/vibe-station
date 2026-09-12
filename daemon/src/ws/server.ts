import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import fastifyWebsocket from "@fastify/websocket";
import { ClientMessage } from "./protocol.js";
import { WSConnection, WS_HARD_LIMIT } from "./connection.js";
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
import { handleDebugLog } from "./handlers/debugLog.js";
import { handleChatOpen, handleChatClose } from "./handlers/chatOpen.js";
import { registerConnection, unregisterConnection, forEachConnection } from "../broadcaster.js";
import { replayNavigateToConnection } from "../routes/open.js";
import { COOKIE_NAME, verifyToken } from "../auth.js";
import type { AuthState } from "../state/auth-state.js";
import type { TokenScope } from "../types.js";

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

type WSAuthResult = {
  scope: TokenScope | null;
  tokenId: string | null;
  issuedAt: number | null;
  expiresAt: number | null;
};

/**
 * Authenticate a WebSocket upgrade request.
 * Returns auth metadata on success, or false if rejected.
 */
function authenticateWS(req: FastifyRequest, authState: AuthState | undefined): WSAuthResult | false {
  if (!authState) return { scope: null, tokenId: null, issuedAt: null, expiresAt: null };

  const viaTunnel = !!req.headers["cf-connecting-ip"];
  // Use req.ip instead of socket.remoteAddress so X-Forwarded-For set by the
  // Vite dev proxy (xfwd: true) is respected when trustProxy is enabled.
  const ip = req.ip;

  const auth = req.headers.authorization;
  const rawToken = auth?.startsWith("Bearer ") ? auth.slice(7) : null;

  const cookieHeader = req.headers.cookie ?? "";
  const cookieToken = parseCookieValue(cookieHeader, COOKIE_NAME);

  // Also read token from query param — browsers can't set WS headers, so the
  // Tauri app passes its Bearer token as ?token=... in the upgrade URL.
  const urlParams = new URLSearchParams(req.url?.split("?")[1] ?? "");
  const queryToken = urlParams.get("token") ?? "";

  const token: string | null = rawToken || cookieToken || queryToken || null;

  if (!viaTunnel && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1")) {
    // Trusted loopback — always allowed. If a token IS present (Tauri Bearer,
    // browser cookie from Vite proxy, or query param), verify it so the
    // connection carries the correct scope instead of null.
    if (token) {
      const result = verifyToken(token, authState);
      if (result.ok) {
        const tokenId = token.slice(0, token.lastIndexOf("."));
        return {
          scope: result.payload.scope,
          tokenId,
          issuedAt: result.payload.iat,
          expiresAt: result.payload.exp ?? null,
        };
      }
    }
    return { scope: null, tokenId: null, issuedAt: null, expiresAt: null };
  }

  if (!token) return false;

  const result = verifyToken(token, authState);
  if (!result.ok) return false;

  const tokenId = token.slice(0, token.lastIndexOf("."));
  return {
    scope: result.payload.scope,
    tokenId,
    issuedAt: result.payload.iat,
    expiresAt: result.payload.exp ?? null,
  };
}

/**
 * Register the /ws WebSocket endpoint on the Fastify instance.
 */
export async function registerWSEndpoint(app: FastifyInstance, authState?: AuthState): Promise<void> {
  // Ensure the websocket plugin is registered
  await app.register(fastifyWebsocket);

  // Heartbeat (socket-cycling fix, Fix 5). Previously nothing ever sent a ping
  // frame and `lastSeenAt` was never swept, so an idle socket could be silently
  // dropped by a NAT / Tailscale / cloudflared tunnel middlebox and the client
  // would reconnect — starting the cycling loop. Now:
  //   - We send WS-level ping frames each tick so the `ws` library can detect
  //     dead peers and the outbound traffic keeps tunnel mappings alive.
  //   - We close connections whose `lastSeenAt` is stale (no app-level message,
  //     including the client's 25s `{type:"ping"}`, for a long time). The client
  //     heartbeat guarantees a healthy connection always has a fresh `lastSeenAt`,
  //     so this only reaps genuinely dead sockets.
  // The interval is `.unref()`d so it never holds the process (or a test) open,
  // and cleared when the Fastify app closes.
  const STALE_CONNECTION_MS = 120_000;
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const heartbeatTimer = setInterval(() => {
    forEachConnection((conn) => {
      try {
        conn.socket.ping();
      } catch {
        /* socket already closing */
      }
      if (Date.now() - conn.lastSeenAt > STALE_CONNECTION_MS) {
        try {
          conn.socket.close(1001, "Heartbeat timeout");
        } catch {
          /* already closed */
        }
      }
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(heartbeatTimer);
  });

  app.get("/ws", { websocket: true }, (socket: WebSocket, req) => {
    // Auth gate — reject before registering the connection
    const authResult = authenticateWS(req, authState);
    if (authResult === false) {
      socket.close(4401, "Unauthorized");
      return;
    }

    const conn = new WSConnection(socket);
    conn.scope = authResult.scope;
    conn.tokenId = authResult.tokenId;
    conn.tokenIssuedAt = authResult.issuedAt;
    conn.tokenExpiresAt = authResult.expiresAt;

    // Register connection for broadcasts
    registerConnection(conn);

    // Replay any pending navigate event (from POST /open) to this new client.
    replayNavigateToConnection(conn);

    // Monitor buffered amount for backpressure. The hard close threshold is
    // intentionally very generous (50MB, shared with `connection.send()`) —
    // terminal scrollback replay across many subscribed sessions can briefly
    // buffer multiple MB at once and we don't want to kill the connection over
    // transient pressure. `connection.send()` now coalesces `session:output`
    // past `WS_SOFT_LIMIT` instead of closing, so this periodic check is the
    // backstop that bounds a truly runaway producer even if the user isn't
    // typing (previously the 1MB check in `send()` ran first and killed the
    // socket on every real-network burst — the socket-cycling regression).
    let lastWarnAt = 0;
    const checkBackpressure = () => {
      const buffered = socket.bufferedAmount || 0;
      if (buffered > 5 * 1024 * 1024 && Date.now() - lastWarnAt > 5000) {
        console.warn(`[WS] Write buffer at ${(buffered / 1_048_576).toFixed(1)}MB`);
        lastWarnAt = Date.now();
      }
      if (buffered > WS_HARD_LIMIT) {
        console.warn(`[WS] Write buffer exceeded ${WS_HARD_LIMIT} bytes (${buffered}), closing connection`);
        socket.close(1009, "Message Too Big");
      }
    };
    const backpressureTimer = setInterval(checkBackpressure, 5000);

    socket.on("message", async (data: Buffer) => {
      conn.lastSeenAt = Date.now();
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
          // JSON agent chat: subscribe + replay + bridge normalized events
          case "chat:open":
            await handleChatOpen(conn, msg);
            break;
          case "chat:close":
            handleChatClose(conn, msg);
            break;
          // Diagnostic channel (mobile double-text investigation)
          case "debug:log":
            handleDebugLog(conn, msg);
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
      clearInterval(backpressureTimer);
      unregisterConnection(conn);
      await conn.cleanup();
    });

    socket.on("error", (err: Error) => {
      console.error("[WS] Socket error:", err);
    });
  });
}
