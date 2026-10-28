import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SkillEditor } from "./SkillEditor";

if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => {} }) as DOMRect;
}
if (typeof Text !== "undefined" && !(Text.prototype as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect) {
  (Text.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => {} }) as DOMRect;
}

function mount(enterBehavior?: "submit" | "newline", extra: { onEscape?: (e?: KeyboardEvent) => void } = {}) {
  const onSubmit = vi.fn();
  const onCtrlEnter = vi.fn();
  render(
    <SkillEditor
      editorKey={`k-${Math.random()}`}
      initialText="hello"
      ariaLabel="Box"
      className="x"
      enterBehavior={enterBehavior}
      onChangeText={() => {}}
      onSubmit={onSubmit}
      onCtrlEnter={enterBehavior === "newline" ? undefined : onCtrlEnter}
      {...extra}
    />,
  );
  return { onSubmit, onCtrlEnter, el: screen.getByLabelText("Box") };
}
const key = async (el: Element, k: string, o: Partial<KeyboardEventInit> = {}) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k, ...o });
  });
};

describe('SkillEditor enterBehavior (4.T7)', () => {
  it('"newline": plain Enter inserts a line break and does not submit; Ctrl/Cmd+Enter submits', async () => {
    const { onSubmit, el } = mount("newline");
    await key(el, "Enter");
    expect(onSubmit).not.toHaveBeenCalled();
    await key(el, "Enter", { ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await key(el, "Enter", { metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("default (submit): plain Enter submits, exactly as before", async () => {
    const { onSubmit, el } = mount();
    await key(el, "Enter");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Escape hands the native event to onEscape (so a caller can stop its propagation)", async () => {
    const onEscape = vi.fn();
    const { el } = mount("newline", { onEscape });
    await key(el, "Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onEscape.mock.calls[0]![0]).toBeInstanceOf(KeyboardEvent);
  });
});
