/**
 * Phase 1 (1.T1) — `runTurnAcp`'s prompt-block ordering.
 *
 * Upstream reads `prompt[0]` for its own slash-command detection, so on
 * turn 1 the user's message block must be pushed BEFORE the system-prompt
 * block (plan Decision 8). This test drives `createClaudePlugin().runTurn`
 * against a fake `AcpConnection` (no real CLI, no network) and inspects the
 * `prompt` array passed to `sendPrompt`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudePlugin } from "../agent-plugins/claude.js";
import type { AgentPlugin, TurnContext } from "../services/spawn.js";
import type { AcpConnection } from "../services/acp/acpTransport.js";
import type { NormalizedEvent } from "../types.js";
import type { PromptBlock } from "../services/acp/acpTransport.js";

describe("claude.ts runTurnAcp — turn-1 prompt-block ordering (1.T1)", () => {
  let cwd: string;
  let plugin: AgentPlugin;
  const SYSTEM_PROMPT = "You are a helpful persona-specific assistant.";

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "claude-turn-ordering-"));
    plugin = createClaudePlugin();
    await writeFile(join(cwd, "system-prompt.md"), SYSTEM_PROMPT, "utf8");
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function makeFakeConnection(): { conn: AcpConnection; capturedPrompts: PromptBlock[][] } {
    const capturedPrompts: PromptBlock[][] = [];
    const conn = {
      currentSessionId: "fake-session-id",
      sendPrompt(_sessionId: string, prompt: PromptBlock[], _signal: AbortSignal) {
        capturedPrompts.push(prompt);
        return {
          updates: (async function* (): AsyncGenerator<NormalizedEvent> {})(),
          result: Promise.resolve({ stopReason: "end_turn" as const }),
        };
      },
    } as unknown as AcpConnection;
    return { conn, capturedPrompts };
  }

  function makeCtx(conn: AcpConnection): TurnContext {
    return {
      cwd,
      project: {} as TurnContext["project"],
      worktree: null,
      session: { id: "sess-1" } as TurnContext["session"],
      systemPromptFile: join(cwd, "system-prompt.md"),
      daemonPort: 0,
      getAcpConnection: async () => conn,
    };
  }

  it("emits the user message block at prompt[0] and the system prompt after it, on turn 1", async () => {
    const { conn, capturedPrompts } = makeFakeConnection();
    const ctx = makeCtx(conn);
    const events: NormalizedEvent[] = [];
    for await (const ev of plugin.runTurn!(
      { message: "/code-review high\nand open a PR", isFirstTurn: true },
      ctx,
      new AbortController().signal,
    )) {
      events.push(ev);
    }

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];
    expect(prompt).toHaveLength(2);
    expect(prompt[0]).toEqual({ type: "text", text: "/code-review high\nand open a PR" });
    expect(prompt[1]).toEqual({ type: "text", text: SYSTEM_PROMPT });

    // session_init is still emitted (agentChatId capture path unaffected by the reorder).
    expect(events.some((e) => e.kind === "session_init" && e.agentChatId === "fake-session-id")).toBe(true);
  });

  it("resumed (non-first) turns send only the user message block, no system prompt", async () => {
    const { conn, capturedPrompts } = makeFakeConnection();
    const ctx = makeCtx(conn);
    const events: NormalizedEvent[] = [];
    for await (const ev of plugin.runTurn!(
      { message: "are you still there?", isFirstTurn: false },
      ctx,
      new AbortController().signal,
    )) {
      events.push(ev);
    }

    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toEqual([{ type: "text", text: "are you still there?" }]);
    expect(events.some((e) => e.kind === "session_init")).toBe(false);
  });
});
