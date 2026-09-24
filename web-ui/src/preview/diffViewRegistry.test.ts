import { describe, expect, it, afterEach } from "vitest";
import { registerActiveDiffView, getActiveDiffView, type DiffViewController } from "./diffViewRegistry";

function makeController(rootEl: HTMLElement): DiffViewController {
  return {
    rootEl,
    toggleLayout: () => {},
    toggleHunkAtFocus: () => {},
  };
}

describe("diffViewRegistry", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("resolves the controller whose rootEl contains document.activeElement", () => {
    const elA = document.createElement("div");
    const elB = document.createElement("div");
    const inner = document.createElement("button");
    elB.appendChild(inner);
    document.body.appendChild(elA);
    document.body.appendChild(elB);
    inner.focus();

    const a = makeController(elA);
    const b = makeController(elB);
    const unregA = registerActiveDiffView(a);
    const unregB = registerActiveDiffView(b);

    expect(getActiveDiffView()).toBe(b);

    unregA();
    unregB();
  });

  it("falls back to the single registered instance when nothing has focus", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const controller = makeController(el);
    const unregister = registerActiveDiffView(controller);

    expect(getActiveDiffView()).toBe(controller);

    unregister();
  });

  it("returns null when nothing has focus and multiple instances are registered", () => {
    const elA = document.createElement("div");
    const elB = document.createElement("div");
    document.body.appendChild(elA);
    document.body.appendChild(elB);

    const unregA = registerActiveDiffView(makeController(elA));
    const unregB = registerActiveDiffView(makeController(elB));

    expect(getActiveDiffView()).toBeNull();

    unregA();
    unregB();
  });

  it("1.T15 — a stale/duplicate unregister call does not remove a different controller", () => {
    const elA = document.createElement("div");
    const elB = document.createElement("div");
    const inner = document.createElement("button");
    elB.appendChild(inner);
    document.body.appendChild(elA);
    document.body.appendChild(elB);
    inner.focus();

    const unregA = registerActiveDiffView(makeController(elA));
    const b = makeController(elB);
    const unregB = registerActiveDiffView(b);

    unregA();
    unregA(); // stale/duplicate unmount — must be a no-op, not remove b

    expect(getActiveDiffView()).toBe(b);

    unregB();
  });
});
