// @ts-nocheck
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";

describe("WebSocket — Phase 1: Connection lifecycle + ping/pong + subscribe", () => {
  let app: FastifyInstance;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    // Start server on a random port
    app = await buildServer({ logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Failed to get server address");
    }
    port = addr.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("connects and receives pong on ping", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    const received: unknown[] = [];

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Timeout waiting for pong"));
      }, 5000);

      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "ping" }));
      });

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString("utf8"));
          received.push(msg);
          if (msg.type === "pong") {
            ws.close();
          }
        } catch (err) {
          ws.close();
          reject(err);
        }
      });

      ws.on("close", () => {
        clearTimeout(timeout);
        expect(received).toEqual([{ type: "pong" }]);
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      });
    });
  });

  it("accepts subscribe message without error", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    const received: unknown[] = [];

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Timeout"));
      }, 5000);

      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "subscribe", sessionIds: ["test-session-1"] }));
        // Give server time to process
        setTimeout(() => ws.close(), 100);
      });

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString("utf8"));
          received.push(msg);
        } catch (err) {
          ws.close();
          reject(err);
        }
      });

      ws.on("close", () => {
        clearTimeout(timeout);
        // Should not receive any error messages for valid subscribe
        expect(received.filter((m: any) => m.type === "system:error")).toHaveLength(0);
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      });
    });
  });

  it("rejects invalid JSON with system:error", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    const received: unknown[] = [];

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Timeout"));
      }, 5000);

      ws.on("open", () => {
        ws.send("invalid json {");
      });

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString("utf8"));
          received.push(msg);
          if (msg.type === "system:error") {
            ws.close();
          }
        } catch (err) {
          ws.close();
          reject(err);
        }
      });

      ws.on("close", () => {
        clearTimeout(timeout);
        expect(received).toContainEqual(expect.objectContaining({ type: "system:error" }));
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      });
    });
  });

  it("rejects invalid message format with system:error", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    const received: unknown[] = [];

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Timeout"));
      }, 5000);

      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "invalid-type" }));
      });

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString("utf8"));
          received.push(msg);
          if (msg.type === "system:error") {
            ws.close();
          }
        } catch (err) {
          ws.close();
          reject(err);
        }
      });

      ws.on("close", () => {
        clearTimeout(timeout);
        expect(received).toContainEqual(expect.objectContaining({ type: "system:error" }));
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      });
    });
  });
});
