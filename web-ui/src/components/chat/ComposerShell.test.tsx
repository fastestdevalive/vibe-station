import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerShell } from "./ComposerShell";

function renderShell(onFocusEditor?: () => void) {
  return render(
    <ComposerShell
      attachments={[]}
      onRemoveAttachment={() => {}}
      onFiles={() => {}}
      {...(onFocusEditor ? { onFocusEditor } : {})}
      toolbarStart={<span data-testid="status">Working…</span>}
      toolbarEnd={<button type="button">Send</button>}
    >
      <div className="chat-skill-editor">
        <div contentEditable suppressContentEditableWarning data-testid="editor" />
      </div>
    </ComposerShell>,
  );
}

describe("ComposerShell — press on dead space focuses the editor", () => {
  it("focuses on a press in the status row and on the bare shell", () => {
    const onFocusEditor = vi.fn();
    const { container } = renderShell(onFocusEditor);
    fireEvent.mouseDown(screen.getByTestId("status"));
    fireEvent.mouseDown(container.querySelector(".chat-composer__shell")!);
    expect(onFocusEditor).toHaveBeenCalledTimes(2);
  });

  it("prevents the press's default so the editor isn't blurred by the shell", () => {
    renderShell(vi.fn());
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    screen.getByTestId("status").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("leaves buttons, the editor itself and non-primary buttons alone", () => {
    const onFocusEditor = vi.fn();
    renderShell(onFocusEditor);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Send" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Attach files" }));
    fireEvent.mouseDown(screen.getByTestId("editor"));
    fireEvent.mouseDown(screen.getByTestId("status"), { button: 2 });
    expect(onFocusEditor).not.toHaveBeenCalled();
  });

  it("does nothing when no focus handler is supplied", () => {
    renderShell();
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    screen.getByTestId("status").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
