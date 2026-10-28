import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Banner } from "./Banner";
import { BottomSheet } from "./BottomSheet";
import { EmptyState } from "./EmptyState";
import { Toast } from "./Toast";

afterEach(() => vi.useRealTimers());

describe("EmptyState", () => {
  it("renders title, description, meta and actions", () => {
    render(
      <EmptyState title="File not found" meta="meta line" actions={<button>Copy path</button>}>
        This file was deleted or moved.
      </EmptyState>,
    );
    expect(screen.getByText("File not found")).toHaveClass("ui-empty__title");
    expect(screen.getByText("This file was deleted or moved.")).toBeInTheDocument();
    expect(screen.getByText("meta line")).toHaveClass("ui-empty__meta");
    expect(screen.getByRole("button", { name: "Copy path" })).toBeInTheDocument();
  });
});

describe("Banner", () => {
  it("warn is a status with the warn class; error is an alert", () => {
    const { rerender } = render(<Banner tone="warn">Showing the first 1 MB of 14 MB</Banner>);
    expect(screen.getByRole("status")).toHaveClass("banner", "banner--warn");
    rerender(<Banner tone="error">Nope</Banner>);
    expect(screen.getByRole("alert")).toHaveClass("banner--error");
  });
  it("renders actions", () => {
    render(<Banner actions={<button>Copy path</button>}>x</Banner>);
    expect(screen.getByRole("button", { name: "Copy path" })).toBeInTheDocument();
  });
});

describe("Toast", () => {
  it("is a status; dismiss button and auto-dismiss call onDismiss", async () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <Toast onDismiss={onDismiss} autoDismissMs={1000}>
        hello
      </Toast>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("hello");
    act(() => void vi.advanceTimersByTime(1000));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
  it("has no dismiss button without onDismiss", () => {
    render(<Toast>plain</Toast>);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});

describe("BottomSheet", () => {
  it("renders a labelled dialog when open and nothing when closed", () => {
    const { rerender } = render(
      <BottomSheet open={false} onClose={() => {}} label="Actions">
        body
      </BottomSheet>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(
      <BottomSheet open onClose={() => {}} label="Actions">
        body
      </BottomSheet>,
    );
    expect(screen.getByRole("dialog", { name: "Actions" })).toHaveTextContent("body");
  });
  it("Esc and a backdrop tap close it", async () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} label="Actions">
        body
      </BottomSheet>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId("bottom-sheet-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
  it("keeps focus in an input across a new onClose identity; Esc calls the latest onClose", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const { rerender } = render(
      <BottomSheet open onClose={a} label="Actions">
        <input aria-label="field" />
      </BottomSheet>,
    );
    const input = screen.getByLabelText("field");
    input.focus();
    rerender(
      <BottomSheet open onClose={b} label="Actions">
        <input aria-label="field" />
      </BottomSheet>,
    );
    expect(document.activeElement).toBe(input);
    await userEvent.keyboard("{Escape}");
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });

