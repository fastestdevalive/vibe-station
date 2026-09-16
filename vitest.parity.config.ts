import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Worktree-local vitest config for the parity harness.
//
// The worktree has no `node_modules` of its own; `node_modules` here is a
// symlink to the base checkout's pnpm virtual store. Vite's resolver follows
// that symlink to its realpath and then looks for bare specifiers (e.g.
// `fastify`) at the TOP level of the base node_modules — where pnpm does NOT
// hoist them. The daemon's third-party deps therefore resolve to nothing under
// vitest, exactly as they would under a bare `tsx` run (this is a real
// environment constraint of this checkout, affecting even the base repo's own
// daemon tests).
//
// Workaround: alias each of the daemon's direct third-party bare specifiers to
// its absolute path in the pnpm virtual store (`node_modules/.pnpm/node_modules`).
// Transitive imports resolve normally from each package's own nested location.
const store = join(
  dirname(fileURLToPath(import.meta.url)),
  "node_modules",
  ".pnpm",
  "node_modules",
);

const daemonDeps = [
  "fastify",
  "better-sqlite3",
  "chokidar",
  "ignore",
  "node-pty",
  "ws",
  "zod",
  "@fastify/cookie",
  "@fastify/cors",
  "@fastify/static",
  "@fastify/websocket",
];

const alias: Record<string, string> = {};
for (const dep of daemonDeps) {
  alias[dep] = join(store, dep);
}

export default defineConfig({
  resolve: {
    preserveSymlinks: true,
    alias,
  },
  test: {
    environment: "node",
    include: ["daemon/src/__tests__/parity*.test.ts"],
  },
});
