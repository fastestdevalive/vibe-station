import { describe, it, expect, afterEach } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

describe("buildServer", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("builds without throwing", async () => {
    app = await buildServer();
    expect(app).toBeDefined();
  });

  it("GET /health returns ok:true, version, port, uptime", async () => {
    app = await buildServer();
    await app.listen({ port: 0, host: "127.0.0.1" });

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ ok: boolean; version: string; port: number; uptime: number }>();
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
  });

  it("GET /health uptime is non-negative", async () => {
    app = await buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });
    const body = response.json<{ uptime: number }>();
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });
});
