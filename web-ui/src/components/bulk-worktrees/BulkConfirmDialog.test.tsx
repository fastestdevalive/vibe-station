import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BulkConfirmDialog, type BulkConfirmItem } from "./BulkConfirmDialog";

const items: BulkConfirmItem[] = [
  { id: "wt-1", label: "code-map-navigation", running: true },
  { id: "wt-2", label: "xxx-widgets-launcher", running: false },
  { id: "wt-3", label: "set-release-builds", running: false },
];

describe("BulkConfirmDialog", () => {
  it("lists the worktrees and the session-removal copy", () => {
    render(<BulkConfirmDialog open items={items} onCancel={() => {}} onConfirm={() => {}} />);

    expect(screen.getByRole("dialog", { name: "Delete 3 worktrees?" })).toBeInTheDocument();
    expect(
      screen.getByText("Sessions attached to these worktrees will be removed from the UI."),
    ).toBeInTheDocument();
    for (const item of items) {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    }
  });

  it("uses the singular title for a single worktree", () => {
    render(<BulkConfirmDialog open items={[items[1]!]} onCancel={() => {}} onConfirm={() => {}} />);

    expect(screen.getByRole("dialog", { name: "Delete 1 worktree?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete 1" })).toBeInTheDocument();
  });

  it("warns about running agents only when a selected worktree has one", () => {
    const { rerender } = render(
      <BulkConfirmDialog open items={items} onCancel={() => {}} onConfirm={() => {}} />,
    );
    expect(
      screen.getByText("1 of these worktrees has an agent running; it will be stopped."),
    ).toBeInTheDocument();

    rerender(
      <BulkConfirmDialog open items={[items[1]!]} onCancel={() => {}} onConfirm={() => {}} />,
    );
    expect(screen.queryByText(/agent running/i)).toBeNull();
  });

  it("warns when the open worktree is being deleted", () => {
    render(
      <BulkConfirmDialog
        open
        items={items}
        openItem={items[0]}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(
      screen.getByText(/You are viewing “code-map-navigation”; you'll be taken to the dashboard\./),
    ).toBeInTheDocument();
  });

  it("calls onConfirm / onCancel from the footer", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <BulkConfirmDialog open items={items} onCancel={onCancel} onConfirm={onConfirm} />,
    );

    await user.click(screen.getByRole("button", { name: "Delete 3" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
