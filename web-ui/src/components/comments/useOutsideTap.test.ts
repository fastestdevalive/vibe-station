import { createEvent, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isInsideCommentLayer, useOutsideTap } from "./useOutsideTap";

interface PtrInit {
  pointerId?: number;
  clientX?: number;
  clientY?: number;
  button?: number;
  pointerType?: string;
  timeStamp?: number;
}

function ptr(type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", el: Element, init: PtrInit = {}) {
  const { timeStamp, ...rest } = init;
  const name = { pointerdown: "pointerDown", pointermove: "pointerMove", pointerup: "pointerUp", pointercancel: "pointerCancel" } as const;
  const ev = createEvent[name[type]](el, { pointerId: 1, clientX: 5, clientY: 5, button: 0, pointerType: "mouse", bubbles: true, ...rest } as never);
  if (timeStamp !== undefined) Object.defineProperty(ev, "timeStamp", { value: timeStamp });
  fireEvent(el, ev);
}

const setup = (inside: (t: EventTarget | null) => boolean = () => false, active = true) => {
  const onTap = vi.fn();
  const hook = renderHook(({ a }) => useOutsideTap(a, { inside, onTap }), { initialProps: { a: active } });
  return { onTap, ...hook };
};

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("useOutsideTap", () => {
  it("a mouse click and a touch tap outside both count", () => {
    const { onTap } = setup();
    ptr("pointerdown", document.body);
    ptr("pointerup", document.body);
    ptr("pointerdown", document.body, { pointerType: "touch", pointerId: 2 });
    ptr("pointerup", document.body, { pointerType: "touch", pointerId: 2 });
    expect(onTap).toHaveBeenCalledTimes(2);
  });

  it("movement threshold: 8px for a mouse, 10px for touch", () => {
    const { onTap } = setup();
    ptr("pointerdown", document.body);
    ptr("pointermove", document.body, { clientX: 14 });
    ptr("pointerup", document.body, { clientX: 14 });
    expect(onTap).not.toHaveBeenCalled();
    ptr("pointerdown", document.body, { clientX: 5 });
    ptr("pointerup", document.body, { clientX: 12 });
    expect(onTap).toHaveBeenCalledTimes(1);
    ptr("pointerdown", document.body, { pointerType: "touch", pointerId: 3 });
    ptr("pointermove", document.body, { pointerType: "touch", pointerId: 3, clientY: 14 });
    ptr("pointerup", document.body, { pointerType: "touch", pointerId: 3, clientY: 14 });
    expect(onTap).toHaveBeenCalledTimes(2);
    ptr("pointerdown", document.body, { pointerType: "touch", pointerId: 4 });
    ptr("pointermove", document.body, { pointerType: "touch", pointerId: 4, clientY: 40 });
    ptr("pointerup", document.body, { pointerType: "touch", pointerId: 4, clientY: 5 });
    expect(onTap).toHaveBeenCalledTimes(2);
  });

  it("a press longer than 600ms is not a tap", () => {
    const { onTap } = setup();
    ptr("pointerdown", document.body, { timeStamp: 1000 });
    ptr("pointerup", document.body, { timeStamp: 1700 });
    expect(onTap).not.toHaveBeenCalled();
    ptr("pointerdown", document.body, { timeStamp: 2000 });
    ptr("pointerup", document.body, { timeStamp: 2500 });
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("pointercancel (a touch pan, a native long-press) cancels", () => {
    const { onTap } = setup();
    ptr("pointerdown", document.body);
    ptr("pointercancel", document.body);
    ptr("pointerup", document.body);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("ignores other pointers, other buttons and a second finger", () => {
    const { onTap } = setup();
    ptr("pointerdown", document.body, { pointerId: 1 });
    ptr("pointerup", document.body, { pointerId: 9 });
    expect(onTap).not.toHaveBeenCalled();
    ptr("pointerup", document.body, { pointerId: 1 });
    expect(onTap).toHaveBeenCalledTimes(1);
    ptr("pointerdown", document.body, { button: 2 });
    ptr("pointerup", document.body, { button: 2 });
    expect(onTap).toHaveBeenCalledTimes(1);
    ptr("pointerdown", document.body, { pointerId: 1, pointerType: "touch" });
    ptr("pointerdown", document.body, { pointerId: 2, pointerType: "touch" });
    ptr("pointerup", document.body, { pointerId: 1, pointerType: "touch" });
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("a non-collapsed selection is not a tap", () => {
    const { onTap } = setup();
    const p = document.body.appendChild(document.createElement("p"));
    p.textContent = "some words";
    const r = document.createRange();
    r.selectNodeContents(p);
    document.getSelection()!.addRange(r);
    ptr("pointerdown", document.body);
    ptr("pointerup", document.body);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("the inside predicate decides, at start and at end; the event is never stopped", () => {
    const box = document.body.appendChild(document.createElement("div"));
    const out = document.body.appendChild(document.createElement("div"));
    const { onTap } = setup((t) => t instanceof Node && box.contains(t));
    ptr("pointerdown", box);
    ptr("pointerup", box);
    ptr("pointerdown", box);
    ptr("pointerup", out);
    expect(onTap).not.toHaveBeenCalled();
    const seen = vi.fn();
    out.addEventListener("pointerup", seen);
    ptr("pointerdown", out);
    ptr("pointerup", out);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("inactive registers nothing and unmount removes every listener", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const off = setup(() => false, false);
    expect(add).not.toHaveBeenCalled();
    ptr("pointerdown", document.body);
    ptr("pointerup", document.body);
    expect(off.onTap).not.toHaveBeenCalled();
    off.rerender({ a: true });
    const added = add.mock.calls.filter(([t]) => String(t).startsWith("pointer")).length;
    expect(added).toBe(4);
    off.unmount();
    expect(remove.mock.calls.filter(([t]) => String(t).startsWith("pointer"))).toHaveLength(4);
    ptr("pointerdown", document.body);
    ptr("pointerup", document.body);
    expect(off.onTap).not.toHaveBeenCalled();
    add.mockRestore();
    remove.mockRestore();
  });
});

describe("isInsideCommentLayer", () => {
  it("knows the float, popovers, dialogs and (optionally) pin stacks", () => {
    document.body.innerHTML = `<div data-comment-float><i id="f"></i></div><div data-comment-stack><b id="s"></b></div><div role="dialog"><u id="d"></u></div><p id="o"></p>`;
    const q = (id: string) => document.getElementById(id);
    expect(isInsideCommentLayer(q("f"), { pins: false })).toBe(true);
    expect(isInsideCommentLayer(q("d"), { pins: false })).toBe(true);
    expect(isInsideCommentLayer(q("s"), { pins: false })).toBe(false);
    expect(isInsideCommentLayer(q("s"), { pins: true })).toBe(true);
    expect(isInsideCommentLayer(q("o"), { pins: true })).toBe(false);
    expect(isInsideCommentLayer(null, { pins: true })).toBe(false);
  });
});
