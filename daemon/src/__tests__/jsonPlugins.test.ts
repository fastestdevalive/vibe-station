import { describe, it, expect } from "vitest";
import { parseCursorStreamLine } from "../agent-plugins/cursor.js";
import { parseOpencodeStreamLine } from "../agent-plugins/opencode.js";
import { parseAgyResultLine } from "../agent-plugins/agy.js";

/**
 * 3.T1 — per-plugin stream-json parsers map their CLI's native events into
 * NormalizedEvents with the correct `provider` + usage mapping. These are the
 * plugins' private normalization boundary (Decision 3); the core never parses.
 */

const SID = "sess-x";

describe("3.T1 — cursor parser", () => {
  it("maps system/init → session_init (model + agentChatId)", () => {
    const evs = parseCursorStreamLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "cur-1", model: "auto" }),
      SID,
    );
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      provider: "cursor",
      kind: "session_init",
      model: "auto",
      agentChatId: "cur-1",
    });
  });

  it("suppresses the user echo", () => {
    expect(parseCursorStreamLine(JSON.stringify({ type: "user", text: "hi" }), SID)).toEqual([]);
  });

  it("streams thinking/delta → thinking", () => {
    const evs = parseCursorStreamLine(
      JSON.stringify({ type: "thinking", subtype: "delta", text: "pondering" }),
      SID,
    );
    expect(evs[0]).toMatchObject({ provider: "cursor", kind: "thinking", text: "pondering" });
  });

  it("maps tool_call/started → tool_use and tool_call/completed → tool_result (same call_id)", () => {
    const started = parseCursorStreamLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        call_id: "c1",
        tool_call: { shellToolCall: { args: { command: "ls" } } },
      }),
      SID,
    );
    expect(started[0]).toMatchObject({
      kind: "tool_use",
      toolId: "c1",
      toolName: "shellToolCall",
      toolInput: { command: "ls" },
    });
    const completed = parseCursorStreamLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "c1",
        tool_call: { shellToolCall: { result: "file.txt" } },
      }),
      SID,
    );
    expect(completed[0]).toMatchObject({ kind: "tool_result", toolId: "c1" });
    expect(completed[0]?.toolResult?.content).toBe("file.txt");
  });

  it("maps result/success → usage + result with summed tokens", () => {
    const evs = parseCursorStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        model: "auto",
        total_cost_usd: 0.01,
        usage: { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
      SID,
    );
    expect(evs.map((e) => e.kind)).toEqual(["usage", "result"]);
    expect(evs[0]?.usage?.totalTokens).toBe(10);
    expect(evs[0]?.usage?.costUsd).toBe(0.01);
    expect(evs[0]?.provider).toBe("cursor");
  });

  it("reads camelCase usage keys → non-zero tokens (live-captured shape)", () => {
    const evs = parseCursorStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        model: "auto",
        usage: { inputTokens: 4633, outputTokens: 359, cacheReadTokens: 22656, cacheWriteTokens: 0 },
      }),
      SID,
    );
    const usageEv = evs.find((e) => e.kind === "usage");
    expect(usageEv?.usage).toMatchObject({
      inputTokens: 4633,
      outputTokens: 359,
      cacheReadTokens: 22656,
      cacheCreateTokens: 0,
      totalTokens: 4633 + 359 + 22656,
    });
  });

  it("tool_call/completed with result.failure → isError true (live-captured shape)", () => {
    const [ev] = parseCursorStreamLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "c9",
        tool_call: {
          shellToolCall: {
            result: { failure: { command: "cat /nope", exitCode: 1, stderr: "No such file" } },
          },
        },
      }),
      SID,
    );
    expect(ev?.kind).toBe("tool_result");
    expect(ev?.toolResult?.isError).toBe(true);
    expect(ev?.toolResult?.content).toContain("No such file");
  });

  it("tool_call/completed with result.success → isError false", () => {
    const [ev] = parseCursorStreamLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "c8",
        tool_call: { shellToolCall: { result: { success: { stdout: "ok", exitCode: 0 } } } },
      }),
      SID,
    );
    expect(ev?.toolResult?.isError).toBe(false);
    expect(ev?.toolResult?.content).toContain("ok");
  });

  it("picks the *ToolCall key even with sibling keys present", () => {
    const [ev] = parseCursorStreamLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        call_id: "c7",
        tool_call: {
          toolCallId: "c7",
          startedAtMs: 1234,
          hookAdditionalContexts: [],
          readToolCall: { args: { path: "a.txt" } },
        },
      }),
      SID,
    );
    expect(ev?.kind).toBe("tool_use");
    expect(ev?.toolName).toBe("readToolCall");
    expect(ev?.toolInput).toEqual({ path: "a.txt" });
  });

  it("result/error → emits a typed error event alongside result", () => {
    const evs = parseCursorStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "error",
        model: "auto",
        result: "rate limited",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      SID,
    );
    expect(evs.map((e) => e.kind)).toEqual(["usage", "result", "error"]);
    const errEv = evs.find((e) => e.kind === "error");
    expect(errEv?.text).toBe("rate limited");
    expect(errEv?.provider).toBe("cursor");
  });

  it("skips malformed lines", () => {
    expect(parseCursorStreamLine("not json {{", SID)).toEqual([]);
  });
});

describe("3.T1 — opencode parser", () => {
  it("surfaces sessionID as session_init exactly once", () => {
    const state = { initEmitted: false };
    const first = parseOpencodeStreamLine(
      JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "hello" } }),
      SID,
      state,
    );
    expect(first.map((e) => e.kind)).toEqual(["session_init", "text"]);
    expect(first[0]).toMatchObject({ provider: "opencode", kind: "session_init", agentChatId: "ses_1" });
    const second = parseOpencodeStreamLine(
      JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "world" } }),
      SID,
      state,
    );
    expect(second.map((e) => e.kind)).toEqual(["text"]);
  });

  it("maps part.type reasoning → thinking and tool running/completed", () => {
    const state = { initEmitted: true };
    const reasoning = parseOpencodeStreamLine(
      JSON.stringify({ type: "reasoning", sessionID: "s", part: { type: "reasoning", text: "hmm" } }),
      SID,
      state,
    );
    expect(reasoning[0]).toMatchObject({ kind: "thinking", text: "hmm" });

    const running = parseOpencodeStreamLine(
      JSON.stringify({
        type: "tool",
        sessionID: "s",
        part: { type: "tool", tool: "bash", callID: "t1", state: { status: "running", input: { cmd: "ls" } } },
      }),
      SID,
      state,
    );
    expect(running[0]).toMatchObject({ kind: "tool_use", toolName: "bash", toolId: "t1", toolInput: { cmd: "ls" } });

    const done = parseOpencodeStreamLine(
      JSON.stringify({
        type: "tool",
        sessionID: "s",
        part: { type: "tool", tool: "bash", callID: "t1", state: { status: "completed", output: "ok" } },
      }),
      SID,
      state,
    );
    expect(done[0]).toMatchObject({ kind: "tool_result", toolId: "t1" });
    expect(done[0]?.toolResult?.content).toBe("ok");
  });

  it("terminal-only tool (run mode) → emits tool_use (name+input) THEN tool_result", () => {
    const state = { initEmitted: true };
    const evs = parseOpencodeStreamLine(
      JSON.stringify({
        type: "tool",
        sessionID: "s",
        part: {
          type: "tool",
          tool: "bash",
          callID: "t9",
          state: { status: "completed", input: { command: "ls -la" }, output: "total 0" },
        },
      }),
      SID,
      state,
    );
    expect(evs.map((e) => e.kind)).toEqual(["tool_use", "tool_result"]);
    expect(evs[0]).toMatchObject({ kind: "tool_use", toolName: "bash", toolId: "t9", toolInput: { command: "ls -la" } });
    expect(evs[1]).toMatchObject({ kind: "tool_result", toolId: "t9" });
    expect(evs[1]?.toolResult?.content).toBe("total 0");
  });

  it("does not duplicate tool_use when a running part preceded the terminal one", () => {
    const state = { initEmitted: true };
    parseOpencodeStreamLine(
      JSON.stringify({
        type: "tool",
        sessionID: "s",
        part: { type: "tool", tool: "bash", callID: "t5", state: { status: "running", input: { c: 1 } } },
      }),
      SID,
      state,
    );
    const done = parseOpencodeStreamLine(
      JSON.stringify({
        type: "tool",
        sessionID: "s",
        part: { type: "tool", tool: "bash", callID: "t5", state: { status: "completed", output: "ok" } },
      }),
      SID,
      state,
    );
    expect(done.map((e) => e.kind)).toEqual(["tool_result"]);
  });

  it("ends the turn on step_finish reason=stop (result); drops reason=tool-calls", () => {
    const state = { initEmitted: true };
    const between = parseOpencodeStreamLine(
      JSON.stringify({ type: "step_finish", sessionID: "s", part: { reason: "tool-calls" } }),
      SID,
      state,
    );
    expect(between).toEqual([]);

    const stop = parseOpencodeStreamLine(
      JSON.stringify({
        type: "step_finish",
        sessionID: "s",
        part: { reason: "stop", tokens: { input: 3, output: 7, cache: { read: 0, write: 0 } } },
      }),
      SID,
      state,
    );
    expect(stop.map((e) => e.kind)).toEqual(["usage", "result"]);
    expect(stop[0]?.usage?.totalTokens).toBe(10);
    expect(stop[0]?.provider).toBe("opencode");
  });
});

describe("3.T1 — agy parser (live-captured 2026-07-15, agy 1.1.2)", () => {
  // agy emits ONE final result envelope per turn (no streamed NDJSON); the
  // parser fans it out into session_init → text → usage → result (+ error).

  it("maps a SUCCESS envelope → session_init, text, usage, result (real capture)", () => {
    const line = JSON.stringify({
      conversation_id: "2ee537a2-ddad-42a4-a2cd-5c4dcc29f38c",
      status: "SUCCESS",
      response: "HELLO_AGY\n",
      duration_seconds: 1.231695252,
      num_turns: 1,
      usage: { input_tokens: 16958, output_tokens: 8, thinking_tokens: 0, total_tokens: 16966 },
    });
    const evs = parseAgyResultLine(line, SID, "Gemini 3.1 Pro (High)");
    expect(evs.map((e) => e.kind)).toEqual(["session_init", "text", "usage", "result"]);
    expect(evs.every((e) => e.provider === "agy")).toBe(true);
    expect(evs[0]).toMatchObject({
      kind: "session_init",
      agentChatId: "2ee537a2-ddad-42a4-a2cd-5c4dcc29f38c",
      model: "Gemini 3.1 Pro (High)",
    });
    expect(evs[1]).toMatchObject({ kind: "text", role: "assistant", text: "HELLO_AGY\n" });
  });

  it("reads agy usage token keys (input/output/total) and reports no cache/cost", () => {
    const line = JSON.stringify({
      conversation_id: "c1",
      status: "SUCCESS",
      response: "ok",
      usage: { input_tokens: 16958, output_tokens: 8, thinking_tokens: 0, total_tokens: 16966 },
    });
    const usageEv = parseAgyResultLine(line, SID, "Gemini 3.5 Flash (Low)").find((e) => e.kind === "usage");
    expect(usageEv?.usage).toMatchObject({
      inputTokens: 16958,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      totalTokens: 16966,
      model: "Gemini 3.5 Flash (Low)",
    });
    expect(usageEv?.usage?.costUsd).toBeUndefined();
  });

  it("maps an ERROR envelope → typed error event alongside result (real capture)", () => {
    const line = JSON.stringify({
      conversation_id: "80fe5fd4-6973-43bc-bfff-38faae93082e",
      status: "ERROR",
      response: "readme.txt\n",
      error:
        "Permission denied for read_file(/home/gb/.gemini/antigravity-cli). Matches hardcoded system protection boundary rule.",
      duration_seconds: 71.376995065,
      num_turns: 2,
      usage: { input_tokens: 147971, output_tokens: 7031, thinking_tokens: 5278, total_tokens: 155002 },
    });
    const evs = parseAgyResultLine(line, SID, "Gemini 3.5 Flash (Low)");
    // status:ERROR with an `error` field emits a typed error event too, and the
    // error text is also carried on the result.
    expect(evs.map((e) => e.kind)).toEqual(["session_init", "text", "usage", "result", "error"]);
    const capturedErr = evs.find((e) => e.kind === "error");
    expect(capturedErr?.provider).toBe("agy");
    expect(capturedErr?.text).toContain("Permission denied for read_file");
    expect(evs.find((e) => e.kind === "result")?.text).toContain("hardcoded system protection");

    // Minimal shape: partial response + short error.
    const errLine = JSON.stringify({
      conversation_id: "x",
      status: "ERROR",
      response: "partial",
      error: "boom",
    });
    const errEvs = parseAgyResultLine(errLine, SID);
    expect(errEvs.map((e) => e.kind)).toEqual(["session_init", "text", "usage", "result", "error"]);
    const errEv = errEvs.find((e) => e.kind === "error");
    expect(errEv).toMatchObject({ provider: "agy", kind: "error", text: "boom" });
    expect(errEvs.find((e) => e.kind === "result")?.text).toBe("boom");
  });

  it("resumed turn carries the same conversation_id as agentChatId", () => {
    const line = JSON.stringify({
      conversation_id: "b69873b6-6867-4830-ae40-fe84ff9707c8",
      status: "SUCCESS",
      response: "OK\n",
      num_turns: 2,
      usage: { input_tokens: 34061, output_tokens: 6, thinking_tokens: 0, total_tokens: 34067 },
    });
    const initEv = parseAgyResultLine(line, SID)[0];
    expect(initEv).toMatchObject({ kind: "session_init", agentChatId: "b69873b6-6867-4830-ae40-fe84ff9707c8" });
  });

  it("skips malformed / non-result lines", () => {
    expect(parseAgyResultLine("not json {{", SID)).toEqual([]);
    expect(parseAgyResultLine("", SID)).toEqual([]);
    // a stray JSON object without conversation_id/status is not our envelope.
    expect(parseAgyResultLine(JSON.stringify({ hello: "world" }), SID)).toEqual([]);
  });
});
