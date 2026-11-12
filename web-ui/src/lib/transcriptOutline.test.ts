import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@/api/types";
import { bucketSizeFor, isOutlineWriteTool, outlineTurnsFromEvents } from "./transcriptOutline";

function ev(logSeq: number, kind: NormalizedEvent["kind"], extra: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return { id: `e${logSeq}`, sessionId: "s1", ts: "2026-01-01T00:00:00Z", provider: "claude", kind, logSeq, ...extra };
}

function userEv(logSeq: number, turnId: string | undefined, text = `prompt ${logSeq}`): NormalizedEvent {
  return ev(logSeq, "user", { role: "user", text, ...(turnId ? { turnId } : {}) });
}

/** The label the outline derives from a prompt's text. */
function outlineLabel(text: string): string {
  return outlineTurnsFromEvents([userEv(1, "t", text)])[0]!.label;
}

describe("turn label", () => {
  it("takes the first non-empty trimmed line", () => {
    expect(outlineLabel("\n   \n  first line  \nsecond")).toBe("first line");
    expect(outlineLabel("alpha\r\nbeta")).toBe("alpha");
  });

  it("removes control characters and caps at 80 code points", () => {
    expect(outlineLabel("a\u001bb\u007fc\u009fd")).toBe("abcd");
    expect(outlineLabel("a".repeat(200))).toBe("a".repeat(80));
    expect(outlineLabel("")).toBe("");
  });
});

describe("isOutlineWriteTool", () => {
  it("is true for edit, delete and move kinds and write-like names", () => {
    expect(isOutlineWriteTool("Bash", "edit")).toBe(true);
    expect(isOutlineWriteTool("Bash", "delete")).toBe(true);
    expect(isOutlineWriteTool("Bash", "move")).toBe(true);
    expect(isOutlineWriteTool("write_file", undefined)).toBe(true);
    expect(isOutlineWriteTool("Read", "read")).toBe(false);
  });
});

describe("bucketSizeFor", () => {
  it("is 1 up to 1000 turns, then ceil(total / 1000)", () => {
    expect(bucketSizeFor(0)).toBe(1);
    expect(bucketSizeFor(1000)).toBe(1);
    expect(bucketSizeFor(1001)).toBe(2);
    expect(bucketSizeFor(2001)).toBe(3);
  });
});

describe("outlineTurnsFromEvents", () => {
  it("opens a turn per distinct user turn key, with a seq:<n> key when there is no turnId", () => {
    const turns = outlineTurnsFromEvents([userEv(1, "t1", "first"), userEv(4, undefined, "second"), userEv(6, "t1")]);
    expect(turns.map((t) => [t.seq, t.turnKey, t.label])).toEqual([
      [1, "t1", "first"],
      [4, "seq:4", "second"],
    ]);
    expect(turns[0]!.ts).toBe("2026-01-01T00:00:00Z");
  });

  it("skips silent user events, superseded rows, nested calls and rows before the first turn", () => {
    const turns = outlineTurnsFromEvents([
      ev(1, "tool_use", { toolId: "early", toolName: "Bash" }),
      userEv(2, "t1"),
      ev(3, "user", { turnId: "t9", silent: true }),
      ev(4, "tool_use", { toolId: "nested", toolName: "Bash", parentToolUseId: "task" }),
      ev(5, "tool_use", { toolId: "gone", toolName: "Bash", superseded: true }),
      ev(6, "tool_use", { toolId: "top", toolName: "Bash" }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.counts).toEqual({ tools: 1, edits: 0, errors: 0 });
  });

  it("counts a call and its result once, and an edit or error once each", () => {
    const turns = outlineTurnsFromEvents([
      userEv(1, "t1"),
      ev(2, "tool_use", { toolId: "a", toolName: "Patch", toolKind: "edit" }),
      ev(3, "tool_result", { toolId: "a", toolName: "Patch", toolKind: "edit", toolResult: { isError: true } }),
      ev(4, "tool_use", { toolId: "b", toolName: "Read", toolStatus: "failed" }),
      ev(5, "tool_result", { toolId: "b", toolName: "Read", toolStatus: "failed" }),
      ev(6, "error"),
    ]);
    expect(turns[0]!.counts).toEqual({ tools: 2, edits: 1, errors: 3 });
  });
});
