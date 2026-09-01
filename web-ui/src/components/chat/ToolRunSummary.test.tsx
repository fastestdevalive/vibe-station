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

// ─── Phase 2.T4: summarizeGroup skips task entries ────────────────────────────

describe("ToolRunSummary summarizeGroup — 2.T4: task entries omitted from summary phrase", () => {
  it("omits 'used task N times' from the summary phrase while keeping other tools", () => {
    const tools: ToolCallEntry[] = [
      { id: "t1", toolName: "Bash", result: { content: "ok" } },
      { id: "t2", toolName: "task", result: { content: "done" } },
      { id: "t3", toolName: "Read", result: { content: "text" } },
    ];
    render(<ToolRunSummary tools={tools} live={false} />);
    const summaryEl = document.querySelector(".chat-tool-run__text");
    expect(summaryEl?.textContent).toBeTruthy();
    expect(summaryEl?.textContent?.toLowerCase()).not.toContain("task");
  });
});

// ─── Phase 3 tests: TaskToolEntry ─────────────────────────────────────────────

import { act, waitFor } from "@testing-library/react";
import { createMockApi } from "@/api/mock";
import type { NormalizedEvent } from "@/api/types";
import { vi } from "vitest";

function chatEv(id: string, kind: NormalizedEvent["kind"], overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id,
    sessionId: "child-1",
    ts: `2024-01-01T00:00:0${id.slice(-1)}Z`,
    provider: "claude",
    kind,
    ...overrides,
  } as NormalizedEvent;
}

describe("TaskToolEntry — 3.T1: no childSessionId renders fallback without ↳ line", () => {
  it("renders the task tool without a ↳ status line when childSessionId is absent", () => {
    const api = createMockApi();
    const tools: ToolCallEntry[] = [{ id: "task-1", toolName: "task" }];
    render(<ToolRunSummary tools={tools} live={true} api={api} />);
    // The ↳ status div should not be present
    expect(document.querySelector(".chat-tool-entry__task-status")).toBeNull();
    // But the task entry itself should be there
    expect(document.querySelector(".chat-tool-entry--task")).toBeTruthy();
  });
});

describe("TaskToolEntry — 3.T2: child has running tool shows ↳ Read", () => {
  it("shows ↳ Read src/foo.ts when child session has an in-progress Read tool", async () => {
    const api = createMockApi();
    // Push a tool_use without a matching tool_result — it's still running
    api.__test.pushChatEvent("child-1", chatEv("ev-1", "tool_use", {
      toolName: "Read",
      toolId: "t1",
      toolInput: { file_path: "src/foo.ts" },
      turnId: "turn-1",
    }));

    const tools: ToolCallEntry[] = [{ id: "task-1", toolName: "task", childSessionId: "child-1" }];
    render(<ToolRunSummary tools={tools} live={true} api={api} />);

    await waitFor(() => {
      const statusEl = document.querySelector(".chat-tool-entry__task-status");
      expect(statusEl?.textContent).toMatch(/↳\s+Read/);
      expect(statusEl?.textContent).toContain("src/foo.ts");
    });
  });
});

describe("TaskToolEntry — 3.T3: completed child shows ↳ N tools", () => {
  it("shows ↳ 2 tools when child has 2 completed tool calls", async () => {
    const api = createMockApi();
    // Two tool_use + two matching tool_result = 2 completed tools
    api.__test.pushChatEvent("child-1", chatEv("ev-1", "tool_use", {
      toolName: "Read", toolId: "t1", turnId: "turn-1", toolInput: { file_path: "a.ts" },
    }));
    api.__test.pushChatEvent("child-1", chatEv("ev-2", "tool_result", {
      toolId: "t1", turnId: "turn-1",
    }));
    api.__test.pushChatEvent("child-1", chatEv("ev-3", "tool_use", {
      toolName: "Read", toolId: "t2", turnId: "turn-1", toolInput: { file_path: "b.ts" },
    }));
    api.__test.pushChatEvent("child-1", chatEv("ev-4", "tool_result", {
      toolId: "t2", turnId: "turn-1",
    }));

    const tools: ToolCallEntry[] = [{ id: "task-1", toolName: "task", childSessionId: "child-1" }];
    render(<ToolRunSummary tools={tools} live={true} api={api} />);

    await waitFor(() => {
      const statusEl = document.querySelector(".chat-tool-entry__task-status");
      expect(statusEl?.textContent).toMatch(/↳\s+2\s+tools/);
    });
  });
});

describe("TaskToolEntry — 3.T4: click calls onNavigate(childSessionId)", () => {
  it("calls onNavigate with the childSessionId when the task entry header is clicked", async () => {
    const api = createMockApi();
    const onNavigate = vi.fn();
    const tools: ToolCallEntry[] = [{ id: "task-1", toolName: "task", childSessionId: "child-nav" }];
    render(<ToolRunSummary tools={tools} live={true} api={api} onNavigate={onNavigate} />);

    await act(async () => {
      const btn = document.querySelector(".chat-tool-entry--task .chat-tool-entry__header") as HTMLButtonElement;
      btn?.click();
    });

    expect(onNavigate).toHaveBeenCalledWith("child-nav");
  });
});

describe("TaskToolEntry — 3.T5: non-task entries render unchanged with no api prop", () => {
  it("renders ToolRunEntryRow for Bash tool without api prop", () => {
    const tools: ToolCallEntry[] = [{ id: "t1", toolName: "Bash", result: { content: "exit 0" } }];
    render(<ToolRunSummary tools={tools} live={false} />);
    expect(document.querySelector(".chat-tool-entry--task")).toBeNull();
    expect(document.querySelector(".chat-tool-entry")).toBeTruthy();
  });
});
