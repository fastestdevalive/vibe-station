// @ts-nocheck
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHealthRoute } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerWorktreeRoutes } from "./routes/worktrees.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerModeRoutes } from "./routes/modes.js";
import { registerWSEndpoint } from "./ws/server.js";

const here = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    // dist/daemon/server.js → ../../package.json when compiled
    const pkgPath = join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    return pkg.version;
  } catch {
    try {
      // src/daemon/server.ts → ../../package.json (ts-node / vitest)
      const pkgPath = join(here, "..", "..", "..", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
      return pkg.version;
    } catch {
      return "0.0.0";
    }
  }
}

export interface BuildServerOptions {
  port?: number;
  logger?: boolean;
}

export async function buildServer(opts: BuildServerOptions = {}) {
  const startedAt = Date.now();
  const version = readVersion();

  const app = Fastify({
    logger: opts.logger ?? false,
  });

  // Expose the version so routes can read it
  (app as typeof app & { vstVersion: string }).vstVersion = version;

  registerHealthRoute(app, startedAt);
  registerProjectRoutes(app);
  registerWorktreeRoutes(app);
  registerSessionRoutes(app);
  registerModeRoutes(app);
  await registerWSEndpoint(app);

  return app;
}
