import { act, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { QueuedTray, type QueuedTrayProps, type QueuedTrayRow, type NoticeSlotInfo } from "./QueuedTray";

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
  it("renders nothing when there are no rows and no noticeSlot", () => {
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

  it("marks a queued turn that came from a scheduled send with a subtle clock (and only that one)", () => {
    renderTray([
      { turnId: "t1", text: "typed", status: "queued" },
      { turnId: "t2", text: "from schedule", status: "queued", scheduled: true },
    ]);
    const marks = screen.getAllByLabelText("Scheduled earlier");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.closest('[role="listitem"]')!.textContent).toContain("from schedule");
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

  // V3b/V3c/V3d — notice slot row (subagent-ux-v2 Phase 3)
  it("V3b — renders a notice row when noticeSlot is provided, even with no human queue rows", () => {
    const noticeSlot: NoticeSlotInfo = { children: { "c1": "Worker" }, running: false };
    renderTray([], { noticeSlot });
    const listItems = screen.getAllByRole("listitem");
    expect(listItems.length).toBeGreaterThanOrEqual(1);
    // Notice row label contains child names
    expect(listItems[0]!.textContent).toContain("Worker");
  });

  it("notice row has Send now and Dismiss, but no Edit", () => {
    const noticeSlot: NoticeSlotInfo = { children: { "c1": "Worker" }, running: false };
    renderTray([], { noticeSlot });
    expect(screen.queryByLabelText("Edit queued message")).toBeNull();
    expect(screen.getByLabelText("Send now")).toBeTruthy();
    expect(screen.getByLabelText("Dismiss wake-up")).toBeTruthy();
  });

  it("clicking Send now on the notice row calls onSendNoticeNow", () => {
    const onSendNoticeNow = vi.fn();
    const noticeSlot: NoticeSlotInfo = { children: { "c1": "Worker" }, running: false };
    renderTray([], { noticeSlot, onSendNoticeNow });
    fireEvent.click(screen.getByLabelText("Send now"));
    expect(onSendNoticeNow).toHaveBeenCalledOnce();
  });

  it("V3d — clicking Dismiss on the notice row calls onDismissNotice", () => {
    const onDismissNotice = vi.fn();
    const noticeSlot: NoticeSlotInfo = { children: { "c1": "Worker" }, running: false };
    renderTray([], { noticeSlot, onDismissNotice });
    fireEvent.click(screen.getByLabelText("Dismiss wake-up"));
    expect(onDismissNotice).toHaveBeenCalledOnce();
  });

  it("hides the notice row when noticeSlot.running === true", () => {
    const noticeSlot: NoticeSlotInfo = { children: { "c1": "Worker" }, running: true };
    renderTray([], { noticeSlot });
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("renders label with child chips for single and plural", () => {
    const singleSlot: NoticeSlotInfo = { children: { "c1": "Worker" }, running: false };
    const { unmount } = renderTray([], { noticeSlot: singleSlot });
    expect(screen.getByText("subagent has update, will wake parent when idle")).toBeTruthy();
    expect(screen.getByText("Worker")).toBeTruthy();
    expect(screen.getByLabelText("Worker subagent has update, will wake parent when idle")).toBeTruthy();
    unmount();

    const pluralSlot: NoticeSlotInfo = { children: { "c1": "Worker", "c2": "Reviewer" }, running: false };
    renderTray([], { noticeSlot: pluralSlot });
    expect(screen.getByText("subagents have update, will wake parent when idle")).toBeTruthy();
    expect(screen.getByText("Worker")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.getByLabelText("Worker, Reviewer subagents have update, will wake parent when idle")).toBeTruthy();
  });

  describe("failed scheduled sends", () => {
    const failed = {
      id: "f1",
      message: "check CI",
      fireAt: "2026-01-01T00:00:00Z",
      failureReason: "Session was archived",
    };

    it("renders the tray with ONLY failed rows, showing text and failure reason", () => {
      renderTray([], { failedRows: [failed] });
      const row = screen.getByRole("listitem");
      expect(row.className).toContain("chat-queued-tray__row--failed");
      expect(row.textContent).toContain("check CI");
      expect(row.textContent).toContain("Session was archived");
      expect(row.getAttribute("aria-label")).toContain("Session was archived");
    });

    it("Retry and Dismiss fire their callbacks with the row id", () => {
      const onFailedRetry = vi.fn();
      const onFailedDismiss = vi.fn();
      renderTray([], { failedRows: [failed], onFailedRetry, onFailedDismiss });
      fireEvent.click(screen.getByLabelText("Retry scheduled send"));
      fireEvent.click(screen.getByLabelText("Dismiss failed scheduled send"));
      expect(onFailedRetry).toHaveBeenCalledWith("f1");
      expect(onFailedDismiss).toHaveBeenCalledWith("f1");
    });

    it("renders failed rows after the scheduled rows", () => {
      renderTray([], {
        scheduledRows: [{ id: "s1", message: "later", fireAt: "2099-01-01T00:00:00Z" }],
        failedRows: [failed],
      });
      const items = screen.getAllByRole("listitem");
      expect(items).toHaveLength(2);
      expect(items[0]!.className).toContain("--scheduled");
      expect(items[1]!.className).toContain("--failed");
    });

    it("renders nothing for an empty failed list", () => {
      const { container } = renderTray([], { failedRows: [] });
      expect(container.firstChild).toBeNull();
    });
  });
});

describe("QueuedTray scheduled countdown", () => {
  afterEach(() => vi.useRealTimers());

  it("re-renders every second while the next send is under 10 minutes away", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    renderTray([], { scheduledRows: [{ id: "s1", message: "soon", fireAt: "2026-01-01T00:02:00Z" }] });
    expect(screen.getByText("in 2m 0s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("in 1m 55s")).toBeTruthy();
  });
});
