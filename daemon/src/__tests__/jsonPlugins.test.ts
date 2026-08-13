import { describe, it, expect } from "vitest";
import { parseCursorStreamLine } from "../agent-plugins/cursor.js";
import { parseOpencodeStreamLine } from "../agent-plugins/opencode.js";
import { parseAgyStreamLine, createAgyStreamState } from "../agent-plugins/agy.js";

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

describe("3.T1 — agy parser (live-captured 2026-08-13, agy 1.1.12, stream-json)", () => {
  // agy streams real per-step NDJSON: init → many step_update → result. Lines
  // below are copied verbatim from a real `agy --output-format stream-json` run.

  it("init event → session_init with agentChatId + fallback model", () => {
    const line = JSON.stringify({
      event: "init",
      conversation_id: "a56a04cd-66b1-44cb-b538-90be2387c438",
      init: { cwd: "/tmp/agytest", tools: ["run_command", "view_file"], permission_mode: "always-proceed" },
    });
    const evs = parseAgyStreamLine(line, SID, createAgyStreamState(), "Gemini 3.1 Pro (High)");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      provider: "agy",
      kind: "session_init",
      agentChatId: "a56a04cd-66b1-44cb-b538-90be2387c438",
      model: "Gemini 3.1 Pro (High)",
    });
  });

  it("agent_response text_delta (ACTIVE) → one text event per chunk", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "beeaebcd-b396-4d7a-9fc3-a0c0ac83f1af",
        step_index: 2,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "I'll run both in parallel since they're independent!",
      },
    });
    const evs = parseAgyStreamLine(line, SID, createAgyStreamState());
    expect(evs).toEqual([
      expect.objectContaining({
        provider: "agy",
        kind: "text",
        role: "assistant",
        text: "I'll run both in parallel since they're independent!",
      }),
    ]);
  });

  it("agent_response text_delta (DONE, carries usage) → text event; usage NOT surfaced as its own event", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "beeaebcd-b396-4d7a-9fc3-a0c0ac83f1af",
        step_index: 2,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "\n",
        duration_seconds: 7.145,
        usage: { input_tokens: 18684, output_tokens: 378, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 19062 },
      },
    });
    const evs = parseAgyStreamLine(line, SID, createAgyStreamState());
    // Per-step usage is not the turn's final usage (Decision 3 — only the
    // `result` event's usage becomes a `usage` NormalizedEvent).
    expect(evs.map((e) => e.kind)).toEqual(["text"]);
    expect(evs[0]?.text).toBe("\n");
  });

  it("empty text_delta emits nothing", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: { step_index: 4, state: "DONE", step_type: "agent_response", duration_seconds: 4.18 },
    });
    expect(parseAgyStreamLine(line, SID, createAgyStreamState())).toEqual([]);
  });

  it("tool step ACTIVE → tool_use, then DONE → tool_result (no duplicate tool_use)", () => {
    const state = createAgyStreamState();
    const activeLine = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "beeaebcd-b396-4d7a-9fc3-a0c0ac83f1af",
        step_index: 3,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "ls -la" } },
      },
    });
    const activeEvs = parseAgyStreamLine(activeLine, SID, state);
    expect(activeEvs).toHaveLength(1);
    expect(activeEvs[0]).toMatchObject({
      provider: "agy",
      kind: "tool_use",
      toolName: "run_command",
      toolId: "3",
      toolInput: { CommandLine: "ls -la" },
    });

    const doneLine = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "beeaebcd-b396-4d7a-9fc3-a0c0ac83f1af",
        step_index: 3,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        duration_seconds: 0.76,
        tool_info: {
          name: "run_command",
          parameters: { CommandLine: "ls -la" },
          output: "total 8\r\ndrwxr-xr-x  2 gb gb 4096 Jul 15 15:17 .\r\n",
        },
      },
    });
    const doneEvs = parseAgyStreamLine(doneLine, SID, state);
    // Already emitted tool_use for step_index "3" — DONE must only add tool_result.
    expect(doneEvs.map((e) => e.kind)).toEqual(["tool_result"]);
    expect(doneEvs[0]).toMatchObject({
      toolId: "3",
      toolResult: { content: "total 8\r\ndrwxr-xr-x  2 gb gb 4096 Jul 15 15:17 .\r\n", isError: false },
    });
  });

  it("tool step arriving DONE-only (fresh state, no prior ACTIVE seen) synthesizes both tool_use and tool_result", () => {
    const doneLine = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 5,
        state: "DONE",
        step_type: "tool",
        tool_name: "view_file",
        tool_info: { name: "view_file", parameters: { AbsolutePath: "/tmp/x" }, output: "contents" },
      },
    });
    const evs = parseAgyStreamLine(doneLine, SID, createAgyStreamState());
    expect(evs.map((e) => e.kind)).toEqual(["tool_use", "tool_result"]);
    expect(evs[0]).toMatchObject({ toolId: "5", toolName: "view_file", toolInput: { AbsolutePath: "/tmp/x" } });
    expect(evs[1]).toMatchObject({ toolId: "5", toolResult: { content: "contents", isError: false } });
  });

  it("tool_info.error (not .output) → tool_result isError:true", () => {
    const doneLine = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 3,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: {}, error: "permission denied" },
      },
    });
    const evs = parseAgyStreamLine(doneLine, SID, createAgyStreamState());
    const resultEv = evs.find((e) => e.kind === "tool_result");
    expect(resultEv?.toolResult).toEqual({ content: "permission denied", isError: true });
  });

  it("no-payload step_types (user_input / unknown / checkpoint / error_message) are dropped", () => {
    for (const step_type of ["user_input", "unknown", "checkpoint", "error_message"]) {
      const line = JSON.stringify({ event: "step_update", step_update: { step_index: 0, state: "DONE", step_type } });
      expect(parseAgyStreamLine(line, SID, createAgyStreamState())).toEqual([]);
    }
  });

  it("result event (SUCCESS) → usage + result, no session_init (init already handled that)", () => {
    const line = JSON.stringify({
      event: "result",
      result: {
        conversation_id: "a56a04cd-66b1-44cb-b538-90be2387c438",
        status: "SUCCESS",
        response: "4\n",
        duration_seconds: 3.88,
        num_turns: 1,
        usage: { input_tokens: 18772, output_tokens: 16, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 18788 },
      },
    });
    const evs = parseAgyStreamLine(line, SID, createAgyStreamState(), "Gemini 3.1 Pro (High)");
    expect(evs.map((e) => e.kind)).toEqual(["usage", "result"]);
    expect(evs[0]).toMatchObject({
      provider: "agy",
      kind: "usage",
      usage: {
        inputTokens: 18772,
        outputTokens: 16,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        totalTokens: 18788,
        model: "Gemini 3.1 Pro (High)",
      },
    });
    expect(evs[1]).toMatchObject({ kind: "result" });
    expect(evs[1]?.usage?.totalTokens).toBe(18788);
  });

  it("result event (ERROR, no prior init — immediate hard-fail on bad --model) → usage + result + error", () => {
    const line = JSON.stringify({
      event: "result",
      result: {
        conversation_id: "",
        status: "ERROR",
        response: "",
        error: 'invalid model selection (--model "totally-bogus-model"): model not recognized',
        duration_seconds: 0,
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
      },
    });
    const evs = parseAgyStreamLine(line, SID, createAgyStreamState(), "totally-bogus-model");
    expect(evs.map((e) => e.kind)).toEqual(["usage", "result", "error"]);
    const errEv = evs.find((e) => e.kind === "error");
    expect(errEv).toMatchObject({ provider: "agy", kind: "error" });
    expect(errEv?.text).toContain("invalid model selection");
    expect(evs.find((e) => e.kind === "result")?.text).toContain("invalid model selection");
  });

  it("skips malformed / non-JSON / unrecognized-event lines", () => {
    expect(parseAgyStreamLine("not json {{", SID, createAgyStreamState())).toEqual([]);
    expect(parseAgyStreamLine("", SID, createAgyStreamState())).toEqual([]);
    expect(parseAgyStreamLine(JSON.stringify({ hello: "world" }), SID, createAgyStreamState())).toEqual([]);
    expect(parseAgyStreamLine(JSON.stringify({ event: "something_future" }), SID, createAgyStreamState())).toEqual([]);
  });
});
