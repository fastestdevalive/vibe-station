import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandoffTurn } from "../services/handoff.js";
import * as tmux from "../services/tmux.js";
import type { SessionRecord } from "../types.js";

vi.mock("../services/tmux.js", () => ({
  pasteBuffer: vi.fn(async () => {}),
}));

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

describe("runHandoffTurn — instruction/poll path consistency (Decision 3/4)", () => {
  afterEach(() => {
    vi.mocked(tmux.pasteBuffer).mockClear();
  });

  it("1.T7 pastes an instruction that contains the SAME freshly-generated path it polls", async () => {
    const handoffPath = join(tmpdir(), `vst-handoff-${Date.now()}.md`);
    const session = makeSession({ useTmux: true, channel: "pty" });

    // File never appears — we only care that delivery happened and named the right path;
    // a short timeout keeps this test fast.
    const result = await runHandoffTurn(session, { timeoutMs: 50, handoffPath, pollMs: 10 });
    expect(result).toBe(false);

    expect(tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    const [, , pastedText] = vi.mocked(tmux.pasteBuffer).mock.calls[0];
    expect(pastedText).toContain(handoffPath);
  });
});
