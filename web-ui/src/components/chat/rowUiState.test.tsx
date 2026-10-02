import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RowUiStateProvider, useRowOpen } from "./rowUiState";

// 2.T3 — expand state survives row unmount/remount via the RowUiStateProvider's
// map. Simulates a virtualized row being unmounted (scrolled out) and remounted
// (scrolled back in): with the provider, the open flag persists; without it,
// the row's local state resets to the default.
function Toggle({ rowKey, defaultOpen }: { rowKey?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useRowOpen(rowKey, defaultOpen ?? false);
  return (
    <button type="button" onClick={() => setOpen(!open)}>
      {open ? "OPEN" : "CLOSED"}
    </button>
  );
}

describe("RowUiStateProvider / useRowOpen (2.T3)", () => {
  it("persists open state across unmount + remount when a rowKey + provider are present", () => {
    const { rerender } = render(
      <RowUiStateProvider>
        <Toggle rowKey="run:1" />
      </RowUiStateProvider>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("CLOSED");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("OPEN");

    // Simulate the row scrolling out of the viewport: unmount it entirely.
    rerender(
      <RowUiStateProvider>
        <div data-testid="other" />
      </RowUiStateProvider>,
    );
    expect(screen.queryByRole("button")).toBeNull();

    // Scroll back in: remount the same rowKey.
    rerender(
      <RowUiStateProvider>
        <Toggle rowKey="run:1" />
      </RowUiStateProvider>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("OPEN");
  });

  it("resets to the default when there is no provider (local state)", () => {
    const { rerender } = render(<Toggle rowKey="run:1" />);
    expect(screen.getByRole("button")).toHaveTextContent("CLOSED");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("OPEN");

    rerender(<div data-testid="other" />);
    rerender(<Toggle rowKey="run:1" />);
    // No provider → local useState resets to the default on remount.
    expect(screen.getByRole("button")).toHaveTextContent("CLOSED");
  });

  it("keys are independent — toggling one rowKey does not affect another", () => {
    render(
      <RowUiStateProvider>
        <Toggle rowKey="run:a" />
        <Toggle rowKey="run:b" />
      </RowUiStateProvider>,
    );
    fireEvent.click(screen.getAllByRole("button")[0]!);
    expect(screen.getAllByRole("button")[0]).toHaveTextContent("OPEN");
    expect(screen.getAllByRole("button")[1]).toHaveTextContent("CLOSED");
  });

  it("honours a non-false default when no stored value exists", () => {
    render(
      <RowUiStateProvider>
        <Toggle rowKey="run:x" defaultOpen />
      </RowUiStateProvider>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("OPEN");
  });
});
