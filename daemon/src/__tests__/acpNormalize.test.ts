import { describe, it, expect } from "vitest";
import { normalizeSessionUpdate } from "../services/acp/normalize.js";

describe("normalizeSessionUpdate (1.T3)", () => {
  it("maps agent_message_chunk to a text event", () => {
    const ev = normalizeSessionUpdate(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      "sess1",
      "claude",
    );
    expect(ev?.kind).toBe("text");
    expect(ev?.text).toBe("hi");
    expect(ev?.role).toBe("assistant");
  });

  it("maps agent_thought_chunk to a thinking event", () => {
    const ev = normalizeSessionUpdate(
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
      "sess1",
      "claude",
    );
    expect(ev?.kind).toBe("thinking");
  });

  it("drops user_message_chunk (daemon-owned kind already synthesizes it)", () => {
    const ev = normalizeSessionUpdate(
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } },
      "sess1",
      "claude",
    );
    expect(ev).toBeNull();
  });

  it("maps a tool_call to tool_use carrying the same toolId, then a matching tool_call_update to tool_result", () => {
    const toolUse = normalizeSessionUpdate(
      { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Bash", rawInput: { command: "ls" } },
      "sess1",
      "claude",
    );
    expect(toolUse?.kind).toBe("tool_use");
    expect(toolUse?.toolId).toBe("tc-1");

    const toolResult = normalizeSessionUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "completed",
        content: [{ content: { type: "text", text: "file1\nfile2" } }],
      },
      "sess1",
      "claude",
    );
    expect(toolResult?.kind).toBe("tool_result");
    expect(toolResult?.toolId).toBe("tc-1");
    expect(toolResult?.toolResult?.content).toContain("file1");
  });

  it("an in-progress tool_call_update (no terminal status) produces a live tool_result event, no toolResult", () => {
    const ev = normalizeSessionUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "in_progress" },
      "sess1",
      "claude",
    );
    expect(ev?.kind).toBe("tool_result");
    expect(ev?.toolStatus).toBe("in_progress");
    expect(ev?.toolResult).toBeUndefined();
  });

  it("agent_message_chunk with a non-text block populates blocks, leaves text undefined", () => {
    const ev = normalizeSessionUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "abc123", mimeType: "image/png" },
      },
      "sess1",
      "claude",
    );
    expect(ev?.kind).toBe("text");
    expect(ev?.text).toBeUndefined();
    expect(ev?.blocks).toEqual([{ type: "image", mimeType: "image/png", data: "abc123" }]);
  });

  it("tool_call with a diff content block populates toolDiffs verbatim", () => {
    const ev = normalizeSessionUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-2",
        content: [{ type: "diff", path: "/a.ts", oldText: "old", newText: "new" }],
      },
      "sess1",
      "claude",
    );
    expect(ev?.toolDiffs).toEqual([{ path: "/a.ts", oldText: "old", newText: "new" }]);
  });

  it("current_mode_update maps to a mode_update event", () => {
    const ev = normalizeSessionUpdate(
      { sessionUpdate: "current_mode_update", currentModeId: "build" },
      "sess1",
      "claude",
    );
    expect(ev?.kind).toBe("mode_update");
    expect(ev?.modeId).toBe("build");
  });

  it("available_commands_update maps to a commands_update event", () => {
    const ev = normalizeSessionUpdate(
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "/plan", description: "Plan mode" }],
      },
      "sess1",
      "claude",
    );
    expect(ev?.kind).toBe("commands_update");
    expect(ev?.commands).toEqual([{ name: "/plan", description: "Plan mode" }]);
  });

  it("maps plan to a status event, never a new kind", () => {
    const ev = normalizeSessionUpdate(
      { sessionUpdate: "plan", entries: [{ content: "step 1" }, { content: "step 2" }] },
      "sess1",
      "claude",
    );
    expect(ev?.kind).toBe("status");
    expect(ev?.text).toContain("step 1");
  });

  it("an unknown update kind is dropped, not thrown", () => {
    const ev = normalizeSessionUpdate({ sessionUpdate: "something_new" }, "sess1", "claude");
    expect(ev).toBeNull();
  });

  it("the enrich hook can replace the default mapping (Decision 2.3)", () => {
    const ev = normalizeSessionUpdate(
      { sessionUpdate: "plan", entries: [] },
      "sess1",
      "claude",
      (_raw, base) => ({ ...base, text: "overridden" }),
    );
    expect(ev?.text).toBe("overridden");
  });
});
