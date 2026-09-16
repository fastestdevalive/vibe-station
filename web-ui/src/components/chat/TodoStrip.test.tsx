import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@/api/types";
import { TodoStrip } from "./TodoStrip";
import { extractTodos, parseTodoResult } from "./toolFormat";

function todoEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: "e1",
    sessionId: "s1",
    ts: "2026-01-01T00:00:00.000Z",
    provider: "opencode",
    kind: "tool_use",
    toolName: "todoWrite",
    toolInput: { todo: "b", status: "in_progress", todos: ["a", "b", "c"] },
    ...overrides,
  };
}

describe("extractTodos", () => {
  it("maps an opencode todos array + active todo into done/active/pending items", () => {
    const items = extractTodos("todoWrite", { todo: "b", status: "in_progress", todos: ["a", "b", "c"] });
    expect(items).toEqual([
      { text: "a", state: "done" },
      { text: "b", state: "active" },
      { text: "c", state: "pending" },
    ]);
  });

  it("marks every item done when status is completed", () => {
    const items = extractTodos("todoWrite", { todo: "c", status: "completed", todos: ["a", "b", "c"] });
    expect(items?.every((i) => i.state === "done")).toBe(true);
  });

  it("parses opencode's object-array todos with per-item status", () => {
    const items = extractTodos("todowrite", {
      todos: [
        { content: "Expand README", status: "completed", priority: "high" },
        { content: "Create CONTRIBUTING.md", status: "in_progress", priority: "medium" },
        { content: "Add docs/", status: "pending", priority: "low" },
      ],
    });
    expect(items).toEqual([
      { text: "Expand README", state: "done" },
      { text: "Create CONTRIBUTING.md", state: "active" },
      { text: "Add docs/", state: "pending" },
    ]);
  });

  it("handles a Claude TodoWrite with only todo + status", () => {
    const items = extractTodos("TodoWrite", { todo: "Write the spec", status: "in_progress" });
    expect(items).toEqual([{ text: "Write the spec", state: "active" }]);
  });

  it("returns undefined for a non-todo tool", () => {
    expect(extractTodos("Read", { file_path: "/a.ts" })).toBeUndefined();
  });
});

describe("parseTodoResult", () => {
  it("parses a markdown checkbox list", () => {
    const items = parseTodoResult("- [x] one\n- [ ] two\n* [X] three");
    expect(items).toEqual([
      { text: "one", state: "done" },
      { text: "two", state: "pending" },
      { text: "three", state: "done" },
    ]);
  });

  it("parses a JSON string array", () => {
    expect(parseTodoResult('["a", "b"]')).toEqual([
      { text: "a", state: "pending" },
      { text: "b", state: "pending" },
    ]);
  });
});

describe("TodoStrip", () => {
  it("renders the live plan with done/active/pending styling while working", () => {
    render(<TodoStrip events={[todoEvent()]} liveState="working" />);
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();
    expect(screen.getByText("c")).toBeTruthy();
    const active = document.querySelector(".chat-todo-strip__item--active") as HTMLElement;
    const done = document.querySelector(".chat-todo-strip__item--done") as HTMLElement;
    expect(active?.textContent).toContain("b");
    expect(done?.textContent).toContain("a");
    expect(screen.getByText("1/3")).toBeTruthy();
  });

  it("is hidden when there are no todo events", () => {
    const { container } = render(<TodoStrip events={[]} liveState="working" />);
    expect(container.querySelector(".chat-todo-strip")).toBeNull();
  });

  it("is shown in any state once a todo snapshot exists", () => {
    for (const state of ["working", "idle", "waiting_for_human", "done", "exited"]) {
      const { container, unmount } = render(<TodoStrip events={[todoEvent()]} liveState={state} />);
      expect(container.querySelector(".chat-todo-strip")).toBeTruthy();
      unmount();
    }
  });

  it("shows the close button only in waiting_for_human", () => {
    const { container: wfh, unmount } = render(<TodoStrip events={[todoEvent()]} liveState="waiting_for_human" />);
    expect(wfh.querySelector(".chat-todo-strip__close")).toBeTruthy();
    unmount();

    const { container: working } = render(<TodoStrip events={[todoEvent()]} liveState="working" />);
    expect(working.querySelector(".chat-todo-strip__close")).toBeNull();
  });

  it("dismissing hides the strip until a NEW todo snapshot arrives", () => {
    const e1 = todoEvent({ id: "e1", toolInput: { todo: "a", status: "in_progress", todos: ["a"] } });
    const e2 = todoEvent({ id: "e2", toolInput: { todo: "b", status: "in_progress", todos: ["b"] } });

    const { rerender, container } = render(<TodoStrip events={[e1]} liveState="waiting_for_human" />);
    expect(container.querySelector(".chat-todo-strip")).toBeTruthy();
    fireEvent.click(container.querySelector(".chat-todo-strip__close") as HTMLElement);
    // Same snapshot still present -> stays dismissed.
    rerender(<TodoStrip events={[e1]} liveState="waiting_for_human" />);
    expect(container.querySelector(".chat-todo-strip")).toBeNull();
    // A new snapshot arrives -> reappears.
    rerender(<TodoStrip events={[e1, e2]} liveState="waiting_for_human" />);
    expect(container.querySelector(".chat-todo-strip")).toBeTruthy();
  });

  it("shows the last snapshot when multiple todoWrite calls exist", () => {
    const events = [
      todoEvent({ id: "e1", toolInput: { todo: "a", status: "in_progress", todos: ["a"] } }),
      todoEvent({ id: "e2", toolInput: { todo: "b", status: "in_progress", todos: ["b"] } }),
    ];
    render(<TodoStrip events={events} liveState="working" />);
    const active = document.querySelector(".chat-todo-strip__item--active") as HTMLElement;
    expect(active?.textContent).toContain("b");
    expect(screen.queryByText("a")).toBeNull();
  });

  it("falls back to parsing the tool result text when toolInput has no todos", () => {
    const events = [
      todoEvent({
        toolInput: {},
        toolResult: { content: "- [x] first\n- [ ] second" },
      }),
    ];
    render(<TodoStrip events={events} liveState="working" />);
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("reads opencode's todo list from the tool_result event's toolInput", () => {
    // Real opencode shape: tool_use has empty {}, the object-array todos arrive
    // on the matching tool_result's refined toolInput.
    const events = [
      todoEvent({ id: "u1", toolId: "u1", toolName: "todowrite", toolInput: {}, kind: "tool_use" }),
      {
        ...todoEvent({ id: "r1", toolId: "u1", kind: "tool_result" }),
        toolInput: {
          todos: [
            { content: "Expand README", status: "completed", priority: "high" },
            { content: "Create CONTRIBUTING.md", status: "in_progress", priority: "medium" },
          ],
        },
      },
    ];
    render(<TodoStrip events={events} liveState="working" />);
    expect(screen.getByText("Expand README")).toBeTruthy();
    const active = document.querySelector(".chat-todo-strip__item--active") as HTMLElement;
    expect(active?.textContent).toContain("Create CONTRIBUTING.md");
    expect(screen.getByText("1/2")).toBeTruthy();
  });
});
