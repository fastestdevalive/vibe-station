import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/hooks/useStore";
import { dismissTop, openEscapeLayers, registerEscapeLayer } from "./escapeLayers";
import { handleToolsEsc } from "./toolsEsc";

const offs: Array<() => void> = [];
const initialStore = useWorkspaceStore.getState();
afterEach(() => {
  useWorkspaceStore.setState(initialStore, true); // undo tests that stub store actions
  while (offs.length) offs.pop()!();
});
const reg = (id: Parameters<typeof registerEscapeLayer>[0], h: () => boolean | void) => {
  const off = registerEscapeLayer(id, h);
  offs.push(off);
  return off;
};

describe("escapeLayers scoping (W2-04)", () => {
  it("a layer scoped to pane B is skipped for a key pressed inside pane A, and taken for one inside B", () => {
    const a = document.body.appendChild(document.createElement("div"));
    const b = document.body.appendChild(document.createElement("div"));
    const inA = a.appendChild(document.createElement("button"));
    const inB = b.appendChild(document.createElement("button"));
    const calls: string[] = [];
    offs.push(registerEscapeLayer("comment-box", () => void calls.push("boxB"), () => b));
    expect(dismissTop(inA)).toBe(false);
    expect(calls).toEqual([]);
    expect(dismissTop(inB)).toBe(true);
    expect(calls).toEqual(["boxB"]);
    // Unscoped layers (the portaled picker) and calls without a target keep applying everywhere.
    offs.push(registerEscapeLayer("picker", () => void calls.push("picker")));
    expect(dismissTop(inA)).toBe(true);
    expect(calls).toEqual(["boxB", "picker"]);
    a.remove();
    b.remove();
  });
});

describe("escapeLayers (4.T10)", () => {
  it("dismisses picker first, then the comment box, then the tray, regardless of registration order", () => {
    const calls: string[] = [];
    reg("tray", () => void calls.push("tray"));
    reg("comment-box", () => void calls.push("box"));
    reg("picker", () => void calls.push("picker"));
    expect(openEscapeLayers()).toEqual(["picker", "comment-box", "tray"]);
    expect(dismissTop()).toBe(true);
    expect(calls).toEqual(["picker"]);
  });

  it("a layer returning false passes the key down; with no layers nothing is handled", () => {
    const calls: string[] = [];
    reg("comment-box", () => {
      calls.push("box");
      return false;
    });
    reg("tray", () => void calls.push("tray"));
    expect(dismissTop()).toBe(true);
    expect(calls).toEqual(["box", "tray"]);
    offs.splice(0).forEach((o) => o());
    expect(dismissTop()).toBe(false);
  });

  it("two boxes: the most recently opened is dismissed first; unregistering removes a layer", () => {
    const calls: string[] = [];
    reg("comment-box", () => void calls.push("old"));
    const off = reg("comment-box", () => void calls.push("new"));
    dismissTop();
    off();
    dismissTop();
    expect(calls).toEqual(["new", "old"]);
  });

  it("handleToolsEsc calls the stack first and stops when a layer took the key", () => {
    const setFullscreen = vi.fn();
    useWorkspaceStore.setState({ workspacePaneFullscreen: "tools", setWorkspacePaneFullscreen: setFullscreen, fileTreeVisible: false, filesLeftPaneMode: {} } as never);
    const layer = vi.fn(() => true);
    reg("comment-box", layer);
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    const stop = vi.spyOn(e, "stopPropagation");
    handleToolsEsc(e, "wt-1");
    expect(layer).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    expect(setFullscreen).not.toHaveBeenCalled();
    offs.splice(0).forEach((o) => o());
    handleToolsEsc(new KeyboardEvent("keydown", { key: "Escape" }), "wt-1");
    expect(setFullscreen).toHaveBeenCalledWith(null);
  });
});
