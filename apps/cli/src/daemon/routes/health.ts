import type { FastifyInstance } from "fastify";

export function registerHealthRoute(app: FastifyInstance, startedAt: number): void {
  app.get("/health", async (_req, reply) => {
    const pkgVersion = (app as FastifyInstance & { vrunVersion?: string }).vrunVersion ?? "0.0.0";
    return reply.send({
      ok: true,
      version: pkgVersion,
      port: (app.server.address() as { port?: number })?.port ?? 0,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    });
  });
}
