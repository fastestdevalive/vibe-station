import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTaskEsc } from "./useTaskEsc";

function Harness({ onClose, active = true }: { onClose: () => void; active?: boolean }) {
  const esc = useTaskEsc({ onClose, enabled: true, isActiveSession: active });
  return (
    <div data-testid="root" tabIndex={-1} onKeyDown={esc.onKeyDown}>
      <input data-testid="text" />
      <textarea data-testid="ta" />
      <select data-testid="sel" />
      <div data-testid="ce" tabIndex={0} contentEditable suppressContentEditableWarning />
      <div role="dialog" data-testid="dlg"><button data-testid="in-dlg" /></div>
      <div role="menu" data-testid="menu"><button data-testid="in-menu" /></div>
      <div role="listbox" data-testid="lb"><button data-testid="in-lb" /></div>
      <input type="checkbox" data-testid="follow" />
      <input type="radio" data-testid="radio" />
      <button data-testid="btn" />
    </div>
  );
}

describe("useTaskEsc", () => {
  it("Esc from the root, a button and a checkbox closes (Follow/Wrap must not block Esc)", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    for (const id of ["root", "btn", "follow", "radio"]) {
      screen.getByTestId(id).focus();
      fireEvent.keyDown(screen.getByTestId(id), { key: "Escape" });
    }
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it("ignores Esc from text entry, select, contenteditable, dialog, menu, listbox", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    for (const id of ["text", "ta", "sel", "ce", "in-dlg", "in-menu", "in-lb"]) {
      screen.getByTestId(id).focus();
      fireEvent.keyDown(screen.getByTestId(id), { key: "Escape" });
    }
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores Esc while an IME composition is active", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    screen.getByTestId("btn").focus();
    fireEvent.keyDown(screen.getByTestId("btn"), { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores Esc while a modal dialog is open anywhere", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    screen.getByTestId("btn").focus();
    fireEvent.keyDown(screen.getByTestId("btn"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    modal.remove();
  });

  it("the container handler stops propagation (a window bubble listener does not fire)", () => {
    const onClose = vi.fn();
    const bubble = vi.fn();
    window.addEventListener("keydown", bubble);
    render(<Harness onClose={onClose} />);
    screen.getByTestId("btn").focus();
    fireEvent.keyDown(screen.getByTestId("btn"), { key: "Escape" });
    window.removeEventListener("keydown", bubble);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(bubble).not.toHaveBeenCalled();
  });

  it("body-focus fallback is capture-phase and stops a WorkspaceCanvas-style bubble listener", () => {
    const onClose = vi.fn();
    const canvas = vi.fn();
    window.addEventListener("keydown", canvas);
    render(<Harness onClose={onClose} />);
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", canvas);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(canvas).not.toHaveBeenCalled();
  });

  it("fallback only fires for the active session and only when focus rests on body", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Harness onClose={onClose} active={false} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Harness onClose={onClose} active />);
    const input = screen.getByTestId("text");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled(); // text entry owns it, and body isn't focused
  });
});
