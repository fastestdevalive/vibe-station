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

