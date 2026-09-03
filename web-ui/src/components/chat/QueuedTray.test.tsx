import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { QueuedTray, type QueuedTrayProps, type QueuedTrayRow } from "./QueuedTray";

function renderTray(rows: QueuedTrayRow[], over: Partial<QueuedTrayProps> = {}) {
  const props: QueuedTrayProps = {
    api: createMockApi(),
    sessionId: "s1",
    rows,
    onEdit: vi.fn(),
    onSendNow: vi.fn(),
    onCancel: vi.fn(),
    onSave: vi.fn(() => Promise.resolve()),
    onDiscard: vi.fn(),
    onSalvage: vi.fn(),
    ...over,
  };
  return { props, ...render(<QueuedTray {...props} />) };
}

describe("QueuedTray", () => {
  it("renders nothing when there are no rows", () => {
    const { container } = renderTray([]);
    expect(container.firstChild).toBeNull();
  });

  it("shows Send now / Edit / Cancel on a queued row and fires callbacks", () => {
    const onSendNow = vi.fn();
    const onEdit = vi.fn();
    const onCancel = vi.fn();
    renderTray([{ turnId: "t1", text: "queued msg", status: "queued" }], { onSendNow, onEdit, onCancel });

    // The Send-now tooltip warns that it interrupts the running turn (preemption).
    expect(screen.getByLabelText("Send now").getAttribute("title")).toMatch(/interrupt/i);

    fireEvent.click(screen.getByLabelText("Send now"));
    fireEvent.click(screen.getByLabelText("Edit queued message"));
    fireEvent.click(screen.getByLabelText("Cancel queued turn"));
    expect(onSendNow).toHaveBeenCalledWith("t1");
    expect(onEdit).toHaveBeenCalledWith("t1");
    expect(onCancel).toHaveBeenCalledWith("t1");
  });

  it("renders a queued turn's skill tokens as `/name args`, never the raw wire braces (Risk 5)", () => {
    renderTray([
      {
        turnId: "t1",
        text: "Use {/code-review high --fix} then tidy a \\{ literal brace",
        status: "queued",
      },
    ]);
    const row = screen.getAllByRole("listitem")[0]!;
    expect(row.textContent).toContain("Use /code-review high --fix then tidy a { literal brace");
    expect(row.textContent).not.toContain("{/");
    expect(row.textContent).not.toContain("\\{");
    // The tooltip and the a11y label go through the same unescaping.
    expect(row.getAttribute("aria-label")).toBe(
      "Queued message: Use /code-review high --fix then tidy a { literal brace",
    );
  });

  it("renders rows oldest-first in the given order", () => {
    renderTray([
      { turnId: "t1", text: "first msg", status: "queued" },
      { turnId: "t2", text: "second msg", status: "queued" },
    ]);
    const items = screen.getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("first msg");
    expect(items[1]!.textContent).toContain("second msg");
  });

  it("renders the inline editor for a row THIS tab is editing (prefilled)", () => {
    renderTray([
      { turnId: "t1", text: "queued msg", status: "editing", draft: { message: "draft text", attachments: [] } },
    ]);
    expect(screen.getByLabelText("Edit queued message").textContent).toBe("draft text");
    expect(screen.getByText("Save")).toBeTruthy();
    expect(screen.getByText("Discard")).toBeTruthy();
  });

  it("m10 — threads `commands` through to the QueuedTurnEditor mount site (skill row renders)", () => {
    renderTray(
      [
        {
          turnId: "t1",
          text: "/code-review high",
          status: "editing",
          draft: { message: "{/code-review high}and open a PR", attachments: [] },
        },
      ],
      { commands: [{ name: "code-review", description: "Review the diff", argumentHint: "[severity]" }] },
    );
    // The skill row only renders when `commands` actually reached
    // QueuedTurnEditor — this is the regression m10 asks for: nothing
    // previously verified `commands` crosses the QueuedTray -> QueuedTurnEditor
    // boundary, only that QueuedTurnEditor works correctly in isolation.
    expect(screen.getByLabelText("Arguments for code-review")).toBeTruthy();
  });

  it("shows a passive 'editing…' badge when another tab is editing (no local draft)", () => {
    renderTray([{ turnId: "t1", text: "queued msg", status: "editing" }]);
    expect(screen.getByText("editing…")).toBeTruthy();
    expect(screen.queryByLabelText("Send now")).toBeNull();
  });

  it("disables Send now / Edit on an unconfirmed optimistic (pending) row", () => {
    renderTray([{ turnId: "p1", text: "just sent", status: "pending" }]);
    expect(screen.getByLabelText("Send now")).toBeDisabled();
    expect(screen.getByLabelText("Edit queued message")).toBeDisabled();
    // Cancel is always safe (works by turnId).
    expect(screen.getByLabelText("Cancel queued turn")).not.toBeDisabled();
  });

  it("moves focus between rows with Arrow keys (roving tabindex)", () => {
    renderTray([
      { turnId: "t1", text: "first", status: "queued" },
      { turnId: "t2", text: "second", status: "queued" },
    ]);
    const [row1, row2] = screen.getAllByRole("listitem");
    row1!.focus();
    fireEvent.keyDown(screen.getByRole("list"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row2);
    fireEvent.keyDown(screen.getByRole("list"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(row1);
  });

  it("returns focus to the composer on Escape", () => {
    const focusComposer = vi.fn();
    renderTray([{ turnId: "t1", text: "first", status: "queued" }], { focusComposer });
    fireEvent.keyDown(screen.getByRole("list"), { key: "Escape" });
    expect(focusComposer).toHaveBeenCalled();
  });
});
