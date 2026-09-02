import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolRunSummary } from "./ToolRunSummary";
import type { ToolCallEntry } from "./toolFormat";

function tool(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  return { id: "t1", toolName: "Bash", ...overrides };
}

describe("ToolRunSummary status-aware spinner/checkmark (Decision 4b, 3.T3)", () => {
  it("renders the spinner for a status:in_progress tool ONLY when live", () => {
    const { rerender } = render(
      <ToolRunSummary tools={[tool({ status: "in_progress" })]} live />,
    );
    expect(document.querySelector(".chat-spinner")).toBeTruthy();

    rerender(<ToolRunSummary tools={[tool({ status: "in_progress" })]} live={false} />);
    expect(document.querySelector(".chat-spinner")).toBeNull();
  });

  it("renders the checkmark, not the spinner, for a status:completed tool", () => {
    render(<ToolRunSummary tools={[tool({ status: "completed" })]} live />);
    expect(document.querySelector(".chat-spinner")).toBeNull();
    expect(document.querySelector(".chat-tool-entry__done")).toBeTruthy();
  });
});

describe("ToolRunSummary shows a file name for a location-only tool call", () => {
  it("falls back to `locations` for the inline summary when toolInput carries nothing usable", () => {
    const tools = [
      tool({
        toolName: "Edit",
        toolInput: {},
        toolKind: "edit",
        locations: [{ path: "/app/README.md" }],
      }),
    ];
    render(<ToolRunSummary tools={tools} live={false} />);
    expect(screen.getByText("/app/README.md")).toBeTruthy();
  });

  it("does not expand into a useless empty {} body when toolInput is {} and locations cover it", () => {
    const tools = [
      tool({ toolName: "Edit", toolInput: {}, locations: [{ path: "/app/README.md" }] }),
    ];
    render(<ToolRunSummary tools={tools} live={false} />);
    const header = document.querySelector(".chat-tool-entry__header") as HTMLElement;
    expect(header.hasAttribute("disabled")).toBe(true);
  });
});

describe("ToolRunSummary — bounded header (Decision 11, Phase 5)", () => {
  function execTool(id: string, command: string): ToolCallEntry {
    // Mirrors an ACP session: toolName IS the full command string, toolKind
    // is the reliable signal.
    return { id, toolName: command, toolKind: "execute" };
  }
  function readTool(id: string, path: string): ToolCallEntry {
    return { id, toolName: `Read ${path}`, toolKind: "read" };
  }

  it("5.T1 — 12 execute + 4 read calls with distinct command-string toolNames produce 'Ran 12 shell commands, read 4 files'", () => {
    const tools = [
      ...Array.from({ length: 12 }, (_, i) => execTool(`e${i}`, `some unique command number ${i} --flag=${i}`)),
      ...Array.from({ length: 4 }, (_, i) => readTool(`r${i}`, `/path/to/file-${i}.ts`)),
    ];
    render(<ToolRunSummary tools={tools} live={false} />);
    expect(screen.getByText("Read 4 files, ran 12 shell commands")).toBeTruthy();
  });

  it("5.T2 — header length is unchanged between a 20-call and a 200-call run of the same kinds", () => {
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => execTool(`e${i}`, `command ${i}`));
    const { unmount } = render(<ToolRunSummary tools={make(20)} live={false} />);
    const short = screen.getByText(/^Ran \d+ shell commands$/).textContent;
    unmount();
    render(<ToolRunSummary tools={make(200)} live={false} />);
    const long = screen.getByText(/^Ran \d+ shell commands$/).textContent;
    expect(short).toBe("Ran 20 shell commands");
    expect(long).toBe("Ran 200 shell commands");
  });

  it("5.T3 — six distinct kinds render 4 clauses plus '+2 more'", () => {
    const tools = [
      readTool("t1", "/a.ts"),
      { id: "t2", toolName: "Write" } as ToolCallEntry,
      { id: "t3", toolName: "Edit", toolKind: "edit" } as ToolCallEntry,
      execTool("t4", "ls -la"),
      { id: "t5", toolName: "Grep", toolKind: "search" } as ToolCallEntry,
      { id: "t6", toolName: "Task", toolKind: "think" } as ToolCallEntry,
    ];
    render(<ToolRunSummary tools={tools} live={false} />);
    const text = screen.getByText(/\+\d+ more/).textContent ?? "";
    // 4 clauses (comma-separated) then a literal "+N more" tail.
    const clauseCount = text.split(", ").length - 1; // last segment is "+N more"
    expect(clauseCount).toBe(4);
    expect(text).toMatch(/\+2 more$/);
  });

  it("5.T4 — a Task call reads 'delegated to 1 subagent', not 'thought 1 time'", () => {
    const tools = [{ id: "t1", toolName: "Task", toolKind: "think" } as ToolCallEntry];
    render(<ToolRunSummary tools={tools} live={false} />);
    expect(screen.getByText("Delegated to 1 subagent")).toBeTruthy();
    expect(screen.queryByText(/thought/i)).toBeNull();
  });

  it("5.T5 — a tool with no toolKind and a 200-char toolName yields a clause ≤ 40 chars", () => {
    const longName = "x".repeat(200);
    const tools = [{ id: "t1", toolName: longName } as ToolCallEntry];
    render(<ToolRunSummary tools={tools} live={false} />);
    const el = document.querySelector(".chat-tool-run__text") as HTMLElement;
    expect(el.textContent!.length).toBeLessThanOrEqual(40);
  });

  it("5.T6 — native (non-ACP) runs with real tool names summarize exactly as before", () => {
    const tools = [
      { id: "t1", toolName: "Read" } as ToolCallEntry,
      { id: "t2", toolName: "Bash" } as ToolCallEntry,
      { id: "t3", toolName: "Grep" } as ToolCallEntry,
    ];
    render(<ToolRunSummary tools={tools} live={false} />);
    expect(screen.getByText("Read 1 file, ran 1 shell command, searched 1 time")).toBeTruthy();
  });
});

describe("ToolRunSummary structured diffs (Decision 3/4, 4.T2)", () => {
  it("renders DiffView via the structured diffs path, not the looksLikeUnifiedDiff heuristic", () => {
    const tools = [
      tool({
        status: "completed",
        diffs: [{ path: "/a.ts", oldText: "a\nb", newText: "a\nc" }],
        result: { content: "not a unified diff at all" },
      }),
    ];
    render(<ToolRunSummary tools={tools} live={false} />);
    // A lone tool run starts expanded (see ToolRunSummary), but the per-tool
    // entry row itself starts collapsed — open it to reveal the diff body.
    const entryHeader = document.querySelector(".chat-tool-entry__header") as HTMLElement;
    fireEvent.click(entryHeader);
    expect(document.querySelector(".diff-line")).toBeTruthy();
    // The heuristic text-diff path (a plain <pre> of resultText) is skipped
    // once structured diffs are present.
    expect(screen.queryByText("not a unified diff at all")).toBeTruthy();
  });
});

