import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent, TranscriptOutlineTurn } from "@/api/types";
import { createMockApi } from "@/api/mock";
import { useOutlineWindows } from "./useOutlineWindows";
import { useTranscriptOutline } from "./useTranscriptOutline";

const TURNS = 30;

/** Thirty turns: a prompt, a Bash call, its result and a reply, with an edit in every fifth turn. */
function buildEvents(): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (let i = 0; i < TURNS; i++) {
    const turnId = `t${i}`;
    const base = i * 4;
    const ts = new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();
    const common = { sessionId: "s1", ts, provider: "claude" as const, turnId };
    events.push({ ...common, id: `${turnId}-user`, kind: "user", role: "user", text: `prompt ${i + 1}`, logSeq: base });
    events.push({
      ...common,
      id: `${turnId}-tool`,
      kind: "tool_use",
      toolName: i % 5 === 0 ? "write_file" : "Bash",
      toolId: `${turnId}-call`,
      toolInput: {},
      logSeq: base + 1,
    });
    events.push({ ...common, id: `${turnId}-result`, kind: "tool_result", toolId: `${turnId}-call`, toolResult: { content: "" }, logSeq: base + 2 });
    events.push({ ...common, id: `${turnId}-reply`, kind: "text", role: "assistant", text: `reply ${i + 1}`, logSeq: base + 3 });
  }
  return events;
}

describe("whole-chat outline on the mock api", () => {
  const events = buildEvents();

  it("the summary and the windows agree with each other", async () => {
    const api = createMockApi({ chat: { s1: events } });
    const { result } = renderHook(() => {
      const summary = useTranscriptOutline(api, "s1");
      const windows = useOutlineWindows(api, "s1", summary.status === "ready" ? summary.revision : null, () => {});
      return { summary, windows };
    });
    await waitFor(() => expect(result.current.summary.status).toBe("ready"));
    const { summary, windows } = result.current;
    expect(summary).toMatchObject({ totalTurns: TURNS, bucketSize: 1, revision: "0" });
    expect(summary.tools).toEqual(new Array(TURNS).fill(1));
    expect(summary.edits.filter((n) => n > 0)).toHaveLength(TURNS / 5);

    const turns: TranscriptOutlineTurn[] = [];
    for (let i = 0; i < TURNS; i++) {
      const turn = await act(() => windows.fetchNow(i));
      expect(turn).not.toBeNull();
      turns.push(turn!);
    }
    expect(turns.map((t) => t.label)).toEqual(Array.from({ length: TURNS }, (_, i) => `prompt ${i + 1}`));
    expect(turns.map((t) => t.seq)).toEqual(Array.from({ length: TURNS }, (_, i) => i * 4));
    expect(turns.map((t) => t.counts.edits)).toEqual(summary.edits);
    expect(turns.map((t) => t.counts.tools)).toEqual(summary.tools);
    expect(turns.map((t) => t.counts.errors)).toEqual(summary.errors);
  });
});
