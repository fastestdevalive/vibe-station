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

describe("BottomSheet focus and keyboard (7.1)", () => {
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

  it("keeps Tab inside the sheet while it is open", async () => {
    render(
      <BottomSheet open onClose={() => {}} label="Actions">
        <button>First</button>
        <button>Last</button>
      </BottomSheet>,
    );
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("dialog", { name: "Actions" }).contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  });

  it("sits above the on-screen keyboard (visualViewport inset) and drops back when it closes", () => {
    const listeners: Record<string, () => void> = {};
    const vv = {
      height: 500,
      offsetTop: 0,
      addEventListener: (t: string, cb: () => void) => (listeners[t] = cb),
      removeEventListener: () => {},
    };
    const prev = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    try {
      render(
        <BottomSheet open onClose={() => {}} label="Actions">
          <button>x</button>
        </BottomSheet>,
      );
      expect(screen.getByRole("dialog").style.bottom).toBe("300px");
      act(() => {
        vv.height = 800;
        listeners.resize?.();
      });
      expect(screen.getByRole("dialog").style.bottom).toBe("");
    } finally {
      if (prev) Object.defineProperty(window, "visualViewport", prev);
      else delete (window as unknown as Record<string, unknown>).visualViewport;
    }
  });
});
