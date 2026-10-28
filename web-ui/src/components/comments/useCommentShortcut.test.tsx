import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isCommentKey, useCommentShortcut } from "./useCommentShortcut";

const key = (o: Partial<KeyboardEvent> & { key: string }) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 67, ...o });

describe("isCommentKey (4.T6)", () => {
  it("c and C only, no modifier, never IME", () => {
    expect(isCommentKey(key({ key: "c" }))).toBe(true);
    expect(isCommentKey(key({ key: "C" }))).toBe(true); // caps lock
    expect(isCommentKey(key({ key: "c", ctrlKey: true }))).toBe(false);
    expect(isCommentKey(key({ key: "c", metaKey: true }))).toBe(false);
    expect(isCommentKey(key({ key: "c", altKey: true }))).toBe(false);
    expect(isCommentKey(key({ key: "C", shiftKey: true }))).toBe(false);
    expect(isCommentKey(key({ key: "c", isComposing: true }))).toBe(false);
    expect(isCommentKey(key({ key: "c", keyCode: 229 }))).toBe(false);
    expect(isCommentKey(key({ key: "x" }))).toBe(false);
  });
});

function Harness({ onSelection, onPlus, inner }: { onSelection: () => boolean; onPlus: (el: HTMLElement) => boolean; inner?: string }) {
  useCommentShortcut(true, { onSelection, onPlus });
  return (
    <div>
      <div data-comment-surface="" data-testid="surface">
        <span data-testid="text">some selectable text</span>
        <button data-comment-plus data-testid="plus" type="button" />
      </div>
      <div dangerouslySetInnerHTML={{ __html: inner ?? "" }} />
      <p data-testid="outside">outside</p>
    </div>
  );
}

function select(el: Element) {
  const r = document.createRange();
  r.selectNodeContents(el);
  const s = document.getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
}

describe("useCommentShortcut guards (4.T6)", () => {
  const setup = (inner?: string) => {
    const onSelection = vi.fn(() => true);
    const onPlus = vi.fn(() => true);
    const utils = render(<Harness onSelection={onSelection} onPlus={onPlus} inner={inner} />);
    return { onSelection, onPlus, ...utils };
  };

  it("fires for a selection inside the surface, and prevents the default", () => {
    const { onSelection, getByTestId } = setup();
    select(getByTestId("text"));
    const ev = new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true });
    getByTestId("text").dispatchEvent(ev);
    expect(onSelection).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("does nothing for a selection outside the surface or no selection", () => {
    const { onSelection, getByTestId } = setup();
    select(getByTestId("outside"));
    fireEvent.keyDown(getByTestId("outside"), { key: "c" });
    document.getSelection()!.removeAllRanges();
    fireEvent.keyDown(getByTestId("text"), { key: "c" });
    expect(onSelection).not.toHaveBeenCalled();
  });

  it("focus on a gutter + triggers onPlus", () => {
    const { onPlus, getByTestId } = setup();
    getByTestId("plus").focus();
    fireEvent.keyDown(getByTestId("plus"), { key: "c" });
    expect(onPlus).toHaveBeenCalledWith(getByTestId("plus"));
  });

  it.each([
    ["input", "<input data-testid='t' />"],
    ["textarea", "<textarea data-testid='t'></textarea>"],
    ["select", "<select data-testid='t'></select>"],
    ["contenteditable", "<div contenteditable='true' data-testid='t'>x</div>"],
    [".xterm", "<div class='xterm'><textarea data-testid='t'></textarea></div>"],
    [".chat-composer", "<div class='chat-composer'><span data-testid='t' tabindex='0'>x</span></div>"],
    [".lexical", "<div class='lexical'><span data-testid='t' tabindex='0'>x</span></div>"],
    ["dialog", "<div role='dialog'><span data-testid='t' tabindex='0'>x</span></div>"],
    ["menu", "<div role='menu'><span data-testid='t' tabindex='0'>x</span></div>"],
  ])("ignores a c typed in %s even with a selection in the surface", (_n, html) => {
    const { onSelection, onPlus, getByTestId } = setup(html);
    select(getByTestId("text"));
    fireEvent.keyDown(getByTestId("t"), { key: "c" });
    expect(onSelection).not.toHaveBeenCalled();
    expect(onPlus).not.toHaveBeenCalled();
  });

  it("modifier chords, IME composition and a disabled hook are ignored", () => {
    const { onSelection, getByTestId } = setup();
    select(getByTestId("text"));
    fireEvent.keyDown(getByTestId("text"), { key: "c", metaKey: true });
    fireEvent.keyDown(getByTestId("text"), { key: "c", ctrlKey: true });
    fireEvent.keyDown(getByTestId("text"), { key: "C", shiftKey: true });
    fireEvent.keyDown(getByTestId("text"), { key: "c", isComposing: true });
    fireEvent.keyDown(getByTestId("text"), { key: "c", keyCode: 229 });
    expect(onSelection).not.toHaveBeenCalled();
  });
});
