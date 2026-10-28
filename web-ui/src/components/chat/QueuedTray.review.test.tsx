import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("QueuedTray review rows (6.T9 / 6.5)", () => {
  it("a queued turn with comments shows 'N review comments · M files · queued' and keeps Edit / Send now / Cancel", () => {
    const { props } = renderTray([{ turnId: "t1", text: "check mobile", status: "queued", review: { count: 3, files: 2 } }]);
    const line = screen.getByTestId("queued-review-line");
    expect(line).toHaveTextContent("3 review comments");
    expect(line).toHaveTextContent("2 files");
    expect(line).toHaveTextContent("· queued");
    // not expandable
    expect(line.querySelector("button")).toBeNull();
    fireEvent.click(screen.getByLabelText("Send now"));
    fireEvent.click(screen.getByLabelText("Edit queued message"));
    fireEvent.click(screen.getByLabelText("Cancel queued turn"));
    expect(props.onSendNow).toHaveBeenCalledWith("t1");
    expect(props.onEdit).toHaveBeenCalledWith("t1");
    expect(props.onCancel).toHaveBeenCalledWith("t1");
  });

  it("a comments-only turn does not say '(attachments only)'", () => {
    renderTray([{ turnId: "t1", text: "", status: "queued", review: { count: 1, files: 1 } }]);
    expect(screen.queryByText("(attachments only)")).toBeNull();
    expect(screen.getByRole("listitem", { name: "Queued message: 1 review comment" })).toBeInTheDocument();
  });

  it("a turn without comments is unchanged", () => {
    renderTray([{ turnId: "t1", text: "plain", status: "queued" }]);
    expect(screen.queryByTestId("queued-review-line")).toBeNull();
  });

  const editing = (review: { count: number; files: number }): QueuedTrayRow => ({
    turnId: "t1",
    text: "msg",
    status: "editing",
    review,
    draft: { message: "msg", attachments: [], review },
  });

  it("editing shows the chip; Save keeps the comments by default (no keepReview argument)", async () => {
    const { props } = renderTray([editing({ count: 3, files: 2 })]);
    expect(screen.getByTestId("queued-review-chip")).toHaveTextContent("3 comments attached");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1));
    expect(props.onSave).toHaveBeenCalledWith("t1", "msg", []);
  });

  it("Detach then Save sends keepReview:false (they return to the panel); Keep undoes the detach", async () => {
    const { props } = renderTray([editing({ count: 1, files: 1 })]);
    fireEvent.click(screen.getByRole("button", { name: "Detach comments" }));
    expect(screen.getByTestId("queued-review-chip")).toHaveTextContent("1 comment returns to the panel");
    fireEvent.click(screen.getByRole("button", { name: "Keep comments" }));
    expect(screen.getByTestId("queued-review-chip")).toHaveTextContent("1 comment attached");
    fireEvent.click(screen.getByRole("button", { name: "Detach comments" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith("t1", "msg", [], false));
  });

  it("an empty edit with the comments kept can be saved (the comments are the message)", async () => {
    const row = editing({ count: 2, files: 1 });
    const { props } = renderTray([{ ...row, text: "", draft: { message: "", attachments: [], review: row.review! } }]);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith("t1", "", []));
  });
});
