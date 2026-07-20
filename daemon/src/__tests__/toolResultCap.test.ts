import { describe, it, expect } from "vitest";
import { capToolResultContent, TOOL_RESULT_MAX_BYTES } from "../services/toolResultCap.js";
import type { NormalizedEvent } from "../types.js";

function toolResultEv(content: string, extra: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: "e1",
    sessionId: "s1",
    ts: new Date().toISOString(),
    provider: "claude",
    kind: "tool_result",
    toolResult: { content },
    ...extra,
  };
}

describe("1.T1 — capToolResultContent", () => {
  it("replaces oversized content with a marker, preserving byte count in the message", () => {
    const big = "x".repeat(TOOL_RESULT_MAX_BYTES + 1);
    const ev = toolResultEv(big);
    capToolResultContent(ev);
    expect(ev.toolResult!.content).toBe(`(tool result omitted — ${TOOL_RESULT_MAX_BYTES + 1} bytes)`);
    expect(ev.toolResult!.content!.length).toBeLessThan(TOOL_RESULT_MAX_BYTES);
  });

  it("leaves normal-size content untouched", () => {
    const small = "a diff or a short file read";
    const ev = toolResultEv(small);
    capToolResultContent(ev);
    expect(ev.toolResult!.content).toBe(small);
  });

  it("caps content exactly at the boundary (max bytes untouched, max+1 capped)", () => {
    const exact = "y".repeat(TOOL_RESULT_MAX_BYTES);
    const evExact = toolResultEv(exact);
    capToolResultContent(evExact);
    expect(evExact.toolResult!.content).toBe(exact);

    const overByOne = "y".repeat(TOOL_RESULT_MAX_BYTES + 1);
    const evOver = toolResultEv(overByOne);
    capToolResultContent(evOver);
    expect(evOver.toolResult!.content).not.toBe(overByOne);
  });

  it("caps oversized content even when isError is true — no exemption (Decision 2)", () => {
    const big = "e".repeat(TOOL_RESULT_MAX_BYTES + 500);
    const ev = toolResultEv(big, {});
    ev.toolResult = { content: big, isError: true };
    capToolResultContent(ev);
    expect(ev.toolResult!.content).not.toBe(big);
    expect(ev.toolResult!.content).toContain("omitted");
    // isError is preserved on the replaced object.
    expect(ev.toolResult!.isError).toBe(true);
  });

  it("no-ops on non-tool_result events", () => {
    const ev: NormalizedEvent = {
      id: "e2",
      sessionId: "s1",
      ts: new Date().toISOString(),
      provider: "claude",
      kind: "text",
      text: "x".repeat(TOOL_RESULT_MAX_BYTES + 1),
    };
    capToolResultContent(ev);
    expect(ev.text).toHaveLength(TOOL_RESULT_MAX_BYTES + 1);
  });

  it("no-ops when toolResult or its content is absent", () => {
    const noResult: NormalizedEvent = {
      id: "e3",
      sessionId: "s1",
      ts: new Date().toISOString(),
      provider: "claude",
      kind: "tool_result",
    };
    expect(() => capToolResultContent(noResult)).not.toThrow();

    const emptyContent: NormalizedEvent = {
      id: "e4",
      sessionId: "s1",
      ts: new Date().toISOString(),
      provider: "claude",
      kind: "tool_result",
      toolResult: { content: "" },
    };
    capToolResultContent(emptyContent);
    expect(emptyContent.toolResult!.content).toBe("");
  });
});
