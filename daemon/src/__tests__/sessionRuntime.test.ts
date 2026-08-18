import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SessionRecord } from "../types.js";

// Mock tmux so no real tmux server is needed.
vi.mock("../services/tmux.js", () => ({
  killSession: vi.fn().mockResolvedValue(undefined),
  hasSession: vi.fn().mockResolvedValue(false),
}));

vi.mock("../services/lifecycle.js", () => ({
  clearIdleTracking: vi.fn(),
}));

vi.mock("../state/attachmentRegistry.js", () => ({
  clearSessionAttachments: vi.fn(),
}));

import { releaseSessionRuntime } from "../services/sessionRuntime.js";
import { killSession, hasSession } from "../services/tmux.js";
import { clearIdleTracking } from "../services/lifecycle.js";
import { clearSessionAttachments } from "../state/attachmentRegistry.js";
import { jsonAgentRegistry } from "../state/jsonAgentRegistry.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";
import type { JsonAgentSession } from "../services/jsonAgent.js";

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s-release-1",
    slot: "a1",
    type: "agent",
    name: "agent",
    tmuxName: "vr-1-a1",
    useTmux: true,
    lifecycle: { state: "idle", lastTransitionAt: new Date().toISOString() },
    ...over,
  } as SessionRecord;
}

/** Minimal JsonAgentSession stand-in — only `release()` is exercised. */
function fakeAgent(): { agent: JsonAgentSession; released: () => number } {
  let calls = 0;
  const agent = {
    release: vi.fn(async () => {
      calls += 1;
    }),
  } as unknown as JsonAgentSession;
  return { agent, released: () => calls };
}

describe("releaseSessionRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jsonAgentRegistry.clear();
    directPtyRegistry.clear?.();
  });

  it("1.T1 — releases and unregisters the JsonAgentSession", async () => {
    const session = makeSession({ id: "s-json", useTmux: false });
    const { agent, released } = fakeAgent();
    jsonAgentRegistry.set(session.id, agent);

    await releaseSessionRuntime(session);

    expect(released()).toBe(1);
    expect(jsonAgentRegistry.get(session.id)).toBeUndefined();
  });

  it("1.T1b — awaits release() before returning (so a late lifecycle write can't outlive the call)", async () => {
    const session = makeSession({ id: "s-json-slow", useTmux: false });
    let finished = false;
    const agent = {
      release: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 20));
        finished = true;
      }),
    } as unknown as JsonAgentSession;
    jsonAgentRegistry.set(session.id, agent);

    await releaseSessionRuntime(session);

    expect(finished).toBe(true);
  });

  it("1.T2 — tmux session: kills the pane by name, never touches the pty registry", async () => {
    const session = makeSession({ id: "s-tmux", useTmux: true, tmuxName: "vr-7-m" });
    const kill = vi.fn();
    directPtyRegistry.set(session.id, { kill } as never);

    await releaseSessionRuntime(session);

    expect(killSession).toHaveBeenCalledWith("vr-7-m");
    expect(kill).not.toHaveBeenCalled();
  });

  it("1.T2b — direct-pty session: kills the child, never calls tmux", async () => {
    const session = makeSession({ id: "s-pty", useTmux: false });
    const kill = vi.fn();
    directPtyRegistry.set(session.id, { kill } as never);

    await releaseSessionRuntime(session);

    expect(kill).toHaveBeenCalledOnce();
    expect(killSession).not.toHaveBeenCalled();
  });

  it("1.T2c — a missing pane / unregistered pty is not an error", async () => {
    // `killSession` never throws in production (it swallows internally,
    // `tmux.ts:27-33`); `hasSession` resolving `false` here is what a
    // "pane already gone" kill looks like from `releaseSessionRuntime`'s
    // perspective.
    vi.mocked(hasSession).mockResolvedValue(false);
    await expect(releaseSessionRuntime(makeSession({ id: "s-gone" }))).resolves.toBeUndefined();
  });

  it("1.T3 — keeps staged attachments by default, clears them only when asked", async () => {
    await releaseSessionRuntime(makeSession({ id: "s-keep" }));
    expect(clearSessionAttachments).not.toHaveBeenCalled();

    await releaseSessionRuntime(makeSession({ id: "s-clear" }), { clearAttachments: true });
    expect(clearSessionAttachments).toHaveBeenCalledWith("s-clear");
  });

  it("1.T3b — always clears the lifecycle poller's idle-hash entry", async () => {
    await releaseSessionRuntime(makeSession({ id: "s-idle" }));
    expect(clearIdleTracking).toHaveBeenCalledWith("s-idle");
  });

  it("2.T1 — kill succeeds, hasSession resolves false immediately: killSession called once, no retry, no warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(hasSession).mockResolvedValue(false);

    await releaseSessionRuntime(makeSession({ id: "s-kill-ok", tmuxName: "vr-kill-ok" }));

    expect(killSession).toHaveBeenCalledTimes(1);
    expect(hasSession).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("2.T2 — hasSession resolves true once then false: killSession called twice, hasSession called twice, no warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(hasSession).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await releaseSessionRuntime(makeSession({ id: "s-kill-retry", tmuxName: "vr-kill-retry" }));

    expect(killSession).toHaveBeenCalledTimes(2);
    expect(hasSession).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("2.T3 — hasSession resolves true both times: killSession called twice, warn called once with session id + tmux name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(hasSession).mockResolvedValue(true);

    await releaseSessionRuntime(makeSession({ id: "s-kill-stuck", tmuxName: "vr-kill-stuck" }));

    expect(killSession).toHaveBeenCalledTimes(2);
    expect(hasSession).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0];
    expect(message).toContain("s-kill-stuck");
    expect(message).toContain("vr-kill-stuck");
    warn.mockRestore();
  });
});
