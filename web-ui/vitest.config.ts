import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// scripts/ci-steps.sh sets VST_CI=1. The local CI runs in a Docker VM that shares
// the host with other projects' CI runs, so a test can be descheduled for seconds.
// With the defaults (one worker per CPU, 5 s per test) a full run there failed 10
// of 3783 tests, a different handful each time, 8 of them on the 5 s timeout.
// These limits only bound a hung test; they assert nothing about speed, so CI
// gets fewer workers and more time. That removed the timeouts but still left 1
// to 3 failures per run in tests that race a real timer (SearchPanel's 200 ms
// debounce, a synchronous query right after an async render); a stall loses
// that race with nothing wrong in the code. So CI also re-runs a failed test
// (up to 2 more times): a real failure still fails all three, a stall does
// not. Local `pnpm test` keeps the defaults, where such a test still shows up.
const ci = process.env.VST_CI === "1";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    ...(ci ? { maxWorkers: 6, testTimeout: 30_000, hookTimeout: 30_000, retry: 2 } : {}),
  },
});
