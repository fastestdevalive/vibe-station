import { describe, it, expect } from "vitest";
import { parseClaudeStreamLine } from "../agent-plugins/claude.js";

const SID = "sess-json-1";

describe("parseClaudeStreamLine (2.T1)", () => {
  it("system/init → session_init with model + chat id", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "chat-abc-123",
      model: "claude-sonnet-4-5",
      tools: ["Bash", "Read"],
    });
    const [ev] = parseClaudeStreamLine(line, SID);
    expect(ev?.kind).toBe("session_init");
    expect(ev?.model).toBe("claude-sonnet-4-5");
    expect(ev?.agentChatId).toBe("chat-abc-123");
    expect(ev?.provider).toBe("claude");
    expect(ev?.sessionId).toBe(SID);
  });

  it("assistant text block → kind:'text'", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Here is the fix" }] },
    });
    const [ev] = parseClaudeStreamLine(line, SID);
    expect(ev?.kind).toBe("text");
    expect(ev?.role).toBe("assistant");
    expect(ev?.text).toBe("Here is the fix");
  });

  it("assistant thinking block → kind:'thinking'", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "let me reason" }] },
    });
    const [ev] = parseClaudeStreamLine(line, SID);
    expect(ev?.kind).toBe("thinking");
    expect(ev?.text).toBe("let me reason");
  });

  it("assistant tool_use block → kind:'tool_use' with name/id/input", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls -la" } }],
      },
    });
    const [ev] = parseClaudeStreamLine(line, SID);
    expect(ev?.kind).toBe("tool_use");
    expect(ev?.toolName).toBe("Bash");
    expect(ev?.toolId).toBe("tu_1");
    expect(ev?.toolInput).toEqual({ command: "ls -la" });
  });

  it("user tool_result block → kind:'tool_result' (claude sends results as `user`)", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "total 24", is_error: false }],
      },
    });
    const [ev] = parseClaudeStreamLine(line, SID);
    expect(ev?.kind).toBe("tool_result");
    expect(ev?.toolId).toBe("tu_1");
    expect(ev?.toolResult?.content).toBe("total 24");
    expect(ev?.toolResult?.isError).toBe(false);
  });

  it("result line → UsageInfo with correct token sums + cost; model from fallback (primary), NOT modelUsage", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      duration_ms: 1200,
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      // A haiku subagent ran this turn; its key must NOT become the reported model.
      modelUsage: { "claude-haiku-4-5": {}, "claude-sonnet-4-5": {} },
      result: "done",
    });
    // The primary/requested model is threaded in as the fallback.
    const events = parseClaudeStreamLine(line, SID, "claude-sonnet-4-5");
    const usageEv = events.find((e) => e.kind === "usage");
    const resultEv = events.find((e) => e.kind === "result");
    expect(usageEv?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreateTokens: 5,
      totalTokens: 165,
      costUsd: 0.0123,
      model: "claude-sonnet-4-5",
    });
    expect(usageEv?.model).toBe("claude-sonnet-4-5");
    expect(resultEv?.usage?.totalTokens).toBe(165);
  });

  it("result line prefers the result's own `model` over the fallback", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      model: "claude-opus-4-5",
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { "claude-haiku-4-5": {} },
    });
    const [usageEv] = parseClaudeStreamLine(line, SID, "claude-sonnet-4-5");
    expect(usageEv?.usage?.model).toBe("claude-opus-4-5");
  });

  it("result line with no model + no fallback → empty model (never a modelUsage key)", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { "claude-haiku-4-5": {} },
    });
    const [usageEv] = parseClaudeStreamLine(line, SID);
    expect(usageEv?.usage?.model).toBe("");
  });

  it("result with is_error → emits a typed error event alongside result", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "API error: overloaded",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const events = parseClaudeStreamLine(line, SID, "claude-sonnet-4-5");
    expect(events.map((e) => e.kind)).toEqual(["usage", "result", "error"]);
    const errEv = events.find((e) => e.kind === "error");
    expect(errEv?.text).toBe("API error: overloaded");
    expect(errEv?.provider).toBe("claude");
  });

  it("rate_limit_event → status event with the limit status", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit: { status: "rejected" },
    });
    const [ev] = parseClaudeStreamLine(line, SID);
    expect(ev?.kind).toBe("status");
    expect(ev?.text).toBe("rate limit: rejected");
    expect(ev?.provider).toBe("claude");
  });

  it("rate_limit_event with `allowed` heartbeat → dropped", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit: { status: "allowed" },
    });
    expect(parseClaudeStreamLine(line, SID)).toEqual([]);
  });

  it("rate_limit_event with no status → dropped (no `rate limit: unknown` noise)", () => {
    const line = JSON.stringify({ type: "rate_limit_event" });
    expect(parseClaudeStreamLine(line, SID)).toEqual([]);
  });

  it("rate_limit_event top-level `status: throttled` → emitted", () => {
    const line = JSON.stringify({ type: "rate_limit_event", status: "throttled" });
    const [ev] = parseClaudeStreamLine(line, SID);
    expect(ev?.kind).toBe("status");
    expect(ev?.text).toBe("rate limit: throttled");
  });

  it("rate_limit_event `Rejected` → emitted lowercased", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit: { status: "Rejected" },
    });
    const [ev] = parseClaudeStreamLine(line, SID);
    expect(ev?.text).toBe("rate limit: rejected");
  });

  it("malformed / empty lines are skipped (Decision 7)", () => {
    expect(parseClaudeStreamLine("not json {{{", SID)).toEqual([]);
    expect(parseClaudeStreamLine("", SID)).toEqual([]);
    expect(parseClaudeStreamLine("   ", SID)).toEqual([]);
    expect(parseClaudeStreamLine("42", SID)).toEqual([]);
  });
});
