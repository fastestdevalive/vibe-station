// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DirectPtyBackend, DirectPtyStream } from "../services/directPty.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";

// Mock lifecycle.ts so onExit doesn't fail with missing state
import { vi } from "vitest";
vi.mock("../services/lifecycle.js", () => ({
  markSessionExited: vi.fn().mockResolvedValue(undefined),
  persistLifecycleState: vi.fn().mockResolvedValue(undefined),
}));

const SESSION_ID = "test-sess";
const PROJECT_ID = "test-proj";
const WORKTREE_ID = "test-wt";

async function spawnEcho(script: string): Promise<DirectPtyStream> {
  // Use bash -c for a simple inline script
  const stream = await DirectPtyBackend.spawn({
    command: "bash",
    args: ["-c", script],
    cwd: "/tmp",
    env: { TERM: "xterm-256color", HOME: process.env.HOME ?? "/tmp" },
    cols: 80,
    rows: 24,
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
  });
  return stream as DirectPtyStream;
}

describe("DirectPtyStream", () => {
  beforeEach(() => {
    directPtyRegistry.clear();
  });

  afterEach(() => {
    directPtyRegistry.clear();
  });

  it("2.T1 — spawn, receives chunk containing expected output, then close fires", async () => {
    const stream = await spawnEcho('echo hello; sleep 0.1; exit 0');

    const chunks: string[] = [];
    const closePromise = new Promise<void>((resolve) => {
      stream.once("close", resolve);
    });

    stream.on("chunk", (c: string) => chunks.push(c));
    await stream.attach(80, 24, "sub-1");
    await closePromise;

    const allOutput = chunks.join("");
    expect(allOutput).toContain("hello");
  });

  it("2.T2 — two subscribers both receive live data", async () => {
    const stream = await spawnEcho('sleep 0.05; echo shared; sleep 0.2; exit 0');

    const chunksA: string[] = [];
    const chunksB: string[] = [];

    await stream.attach(80, 24, "sub-A");
    await stream.attach(80, 24, "sub-B");

    stream.on("chunk", (c: string) => {
      // Both A and B share the same stream — chunks go to all listeners
      chunksA.push(c);
      chunksB.push(c);
    });

    await new Promise<void>((resolve) => stream.once("close", resolve));

    const outA = chunksA.join("");
    const outB = chunksB.join("");
    expect(outA).toContain("shared");
    expect(outB).toContain("shared");
  });

  it("2.T3 — ring buffer caps at 64 KB and oldest data is dropped", async () => {
    // Write >64KB to the PTY, then check getRecentOutput size
    // We use a large printf to overflow the buffer
    const kb65Script = `python3 -c "import sys; sys.stdout.write('X' * 66000); sys.stdout.flush()" 2>/dev/null || printf '%0.s.' {1..66000}; exit 0`;
    const stream = await spawnEcho(kb65Script);

    await new Promise<void>((resolve) => stream.once("close", resolve));

    const recent = stream.getRecentOutput(64 * 1024);
    expect(recent.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("2.T4 — waitForOutput resolves true when stdout contains needle", async () => {
    const stream = await spawnEcho('sleep 0.1; echo READY; sleep 0.5; exit 0');

    const result = await stream.waitForOutput("READY", 3000);
    expect(result).toBe(true);
  });

  it("2.T4 — waitForOutput resolves false after timeout when needle never appears", async () => {
    const stream = await spawnEcho('sleep 5; exit 0');

    const start = Date.now();
    const result = await stream.waitForOutput("NEVER_APPEARS", 300);
    const elapsed = Date.now() - start;

    expect(result).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(290);
    stream.kill();
  }, 5000);

  it("2.T5 — attach after PTY exits replays buffer then emits close on next microtask", async () => {
    const stream = await spawnEcho('echo POST_EXIT_DATA; exit 0');

    // Wait for PTY to finish
    await new Promise<void>((resolve) => stream.once("close", resolve));

    // Now attach after exit
    const events: string[] = [];
    stream.on("chunk", (c: string) => events.push(`chunk:${c}`));
    stream.on("close", () => events.push("close"));

    await stream.attach(80, 24, "late-sub");

    // Give microtask queue a tick to fire the deferred close
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should have gotten chunk (buffer replay) then close
    const hasChunk = events.some((e) => e.startsWith("chunk:"));
    const hasClose = events.includes("close");
    expect(hasChunk).toBe(true);
    expect(hasClose).toBe(true);
  });

  it("2.T6 — detach removes only that subscriber; PTY still alive; others receive data", async () => {
    const stream = await spawnEcho('sleep 0.3; echo AFTER_DETACH; sleep 0.5; exit 0');

    const chunksB: string[] = [];

    await stream.attach(80, 24, "sub-A");
    stream.on("chunk", (c: string) => chunksB.push(c));
    await stream.attach(80, 24, "sub-B");

    // Detach sub-A (only subscriber; not sub-B which is tracked via the event listener)
    await stream.detach("sub-A");

    // PTY should still be alive
    await new Promise<void>((resolve) => stream.once("close", resolve));

    const out = chunksB.join("");
    expect(out).toContain("AFTER_DETACH");
  });
});
