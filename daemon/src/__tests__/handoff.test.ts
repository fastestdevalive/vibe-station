import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, utimesSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandoffTurn, readFreshHandoffFileOrNull } from "../services/handoff.js";
import type { SessionRecord } from "../types.js";

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session-1",
    projectId: "project-1",
    isMain: true,
    sortOrder: 0,
    type: "agent",
    tmuxName: "vst-session-1",
    useTmux: false,
    lifecycle: { state: "running", lastTransitionAt: new Date().toISOString() },
    ...overrides,
  } as SessionRecord;
}

describe("runHandoffTurn", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("1.T1 deletes a pre-existing stale handoff file and actually waits, instead of returning true instantly", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-handoff-test-"));
    const handoffPath = join(tempDir, "HANDOFF.md");
    await writeFile(handoffPath, "stale summary from a prior run");

    vi.useFakeTimers();
    const session = makeSession({ useTmux: false, channel: "pty" });
    const promise = runHandoffTurn(session, { timeoutMs: 3000, handoffPath, pollMs: 500 });

    // Flush the synchronous-ish setup (unlink + delivery attempt) before the
    // poll loop's first setTimeout is scheduled.
    await vi.advanceTimersByTimeAsync(0);
    expect(existsSync(handoffPath)).toBe(false); // stale file was deleted, not left in place

    // Let the full timeout elapse; nothing recreates the file.
    await vi.advanceTimersByTimeAsync(3000);
    await expect(promise).resolves.toBe(false);
  });

  it("1.T2 returns false immediately for json-channel sessions, without waiting out the timeout", async () => {
    vi.useFakeTimers();
    const session = makeSession({ channel: "json" });
    // If this ever polls again, the promise would hang forever since we never
    // advance the fake timers — the test would time out, catching a regression.
    const result = await runHandoffTurn(session, {
      timeoutMs: 60_000,
      handoffPath: "/nonexistent/HANDOFF.md",
    });
    expect(result).toBe(false);
  });
});

describe("readFreshHandoffFileOrNull (Bug 6 fix)", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("returns the file's content when it was modified within maxAgeMs", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-handoff-fresh-test-"));
    const handoffPath = join(tempDir, "HANDOFF.md");
    await writeFile(handoffPath, "self-written handoff summary");

    const result = await readFreshHandoffFileOrNull(handoffPath, 30_000);
    expect(result).toBe("self-written handoff summary");
  });

  it("returns null when the file is older than maxAgeMs", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-handoff-fresh-test-"));
    const handoffPath = join(tempDir, "HANDOFF.md");
    await writeFile(handoffPath, "stale summary from a much earlier run");
    const old = new Date(Date.now() - 60_000);
    utimesSync(handoffPath, old, old);

    const result = await readFreshHandoffFileOrNull(handoffPath, 30_000);
    expect(result).toBeNull();
  });

  it("returns null when the file does not exist", async () => {
    const result = await readFreshHandoffFileOrNull("/nonexistent/HANDOFF.md", 30_000);
    expect(result).toBeNull();
  });

  it("returns null for a fresh but empty/whitespace-only file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-handoff-fresh-test-"));
    const handoffPath = join(tempDir, "HANDOFF.md");
    await writeFile(handoffPath, "   \n  ");

    const result = await readFreshHandoffFileOrNull(handoffPath, 30_000);
    expect(result).toBeNull();
  });
});
