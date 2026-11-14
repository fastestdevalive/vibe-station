import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useRowContextMenu } from "./useRowContextMenu";

const mobile = { value: false };
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mobile.value }));

function Harness({ onPick }: { onPick: (name: string) => void }) {
  const menu = useRowContextMenu<{ name: string }>({
    resolve: (el) => {
      const row = el.closest<HTMLElement>("[data-row]");
      return row ? { row, t: { name: row.dataset.row! } } : null;
    },
    items: (t, close) => (
      <button type="button" role="menuitem" onClick={() => { onPick(t.name); close(true); }}>
        Pick {t.name}
      </button>
    ),
  });
  return (
    <div data-testid="container" onContextMenu={menu.rowProps.onContextMenu} onKeyDown={menu.rowProps.onKeyDown} {...menu.longPressProps}>
      <div data-row="a" tabIndex={0}>A</div>
      <div data-row="b" tabIndex={0}>B</div>
      {menu.menu}
    </div>
  );
}

describe("useRowContextMenu (tools-pane-rework B7.1)", () => {
  beforeEach(() => {
    mobile.value = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("right-click on a row opens the menu and prevents the native menu", () => {
    render(<Harness onPick={vi.fn()} />);
    const row = screen.getByText("A");
    const notCancelled = fireEvent.contextMenu(row, { clientX: 10, clientY: 20 });
    expect(notCancelled).toBe(false); // preventDefault was called
    expect(screen.getByRole("menu", { name: "Actions" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Pick a" })).toBeInTheDocument();
  });

  it("Shift+F10 and the ContextMenu key open the menu for the focused row", () => {
    render(<Harness onPick={vi.fn()} />);
    const row = screen.getByText("B");
    row.focus();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "Pick b" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Pick b" }), { key: "Escape" });
    fireEvent.keyDown(row, { key: "ContextMenu" });
    expect(screen.getByRole("menuitem", { name: "Pick b" })).toBeInTheDocument();
  });

  it("a touch long-press (500 ms) opens the menu; a short press does not", () => {
    vi.useFakeTimers();
    render(<Harness onPick={vi.fn()} />);
    const row = screen.getByText("A");
    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 5, clientY: 6, isPrimary: true });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerUp(row);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByRole("menuitem", { name: "Pick a" })).toBeNull();

    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 5, clientY: 6, isPrimary: true });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole("menuitem", { name: "Pick a" })).toBeInTheDocument();
  });

  it("on phones the menu renders as the bottom sheet (the mobile menu shell)", () => {
    mobile.value = true;
    render(<Harness onPick={vi.fn()} />);
    fireEvent.contextMenu(screen.getByText("A"), { clientX: 1, clientY: 1 });
    expect(document.querySelector(".artifacts-menu--sheet")).not.toBeNull();
  });

  it("Esc closes the menu and returns focus to the row", () => {
    render(<Harness onPick={vi.fn()} />);
    const row = screen.getByText("A");
    row.focus();
    fireEvent.contextMenu(row, { clientX: 1, clientY: 1 });
    const item = screen.getByRole("menuitem", { name: "Pick a" });
    item.focus();
    fireEvent.keyDown(item, { key: "Escape" });
    expect(screen.queryByRole("menuitem", { name: "Pick a" })).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("a pick runs the item and closes the menu", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.contextMenu(screen.getByText("B"), { clientX: 1, clientY: 1 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Pick b" }));
    expect(onPick).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
