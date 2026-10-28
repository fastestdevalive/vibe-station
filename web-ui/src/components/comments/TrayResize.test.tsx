import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { dismissTop } from "@/lib/escapeLayers";
import { CommentsTray } from "./CommentsTray";
import { makeApi, makeSession } from "./testHarness";
import { makeComment as c } from "./testFixtures";
import { useCommentStore } from "./useCommentStore";
import { TRAY_HEIGHT_KEY, clampTrayHeight, readStoredTrayHeight } from "./useTrayHeight";

vi.mock("@/hooks/useVirtualKeyboardVisible", () => ({ useVirtualKeyboardVisible: () => false }));

const seed = (comments = [c({ id: "a" }), c({ id: "b", pin: 2 })]) =>
  act(() => useCommentStore.getState().replace("wt-1", "worktree", { comments, nextPin: 20, terminalDeliveries: [] }));
const mount = () => render(<CommentsTray api={makeApi()} scopeId="wt-1" scopeKind="worktree" />);
const expand = () => fireEvent.click(screen.getByRole("button", { name: /^\d+ comments?$/ }));
const handle = () => screen.getByRole("separator", { name: "Resize comments list" });
const list = () => document.querySelector<HTMLElement>(".comment-tray__list")!;
const heightOf = () => Number.parseFloat(list().style.height);

/** ResizeObserver stub + a settable column height, so the tray's clamp has a column to measure. */
let columnH = 800;
let roCallbacks: Array<() => void> = [];
let rafQueue: FrameRequestCallback[] = [];
/** Run the queued animation frames (the drag coalesces moves into one frame). */
const flushFrames = () => act(() => void rafQueue.splice(0).forEach((cb) => cb(0)));

function pointer(type: string, target: Element | Window, init: { clientX?: number; clientY: number; timeStamp?: number }) {
  const ev = createEvent[type as "pointerDown"](target as Element, { clientX: init.clientX ?? 0, clientY: init.clientY, pointerId: 1, button: 0 });
  // jsdom's generic events drop the pointer fields: define them
  Object.defineProperty(ev, "clientY", { value: init.clientY });
  Object.defineProperty(ev, "clientX", { value: init.clientX ?? 0 });
  if (init.timeStamp !== undefined) Object.defineProperty(ev, "timeStamp", { value: init.timeStamp });
  fireEvent(target, ev);
}

beforeEach(() => {
  localStorage.clear();
  columnH = 800;
  roCallbacks = [];
  rafQueue = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => rafQueue.push(cb));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        roCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const h = this.classList.contains("comment-tray__strip") ? 40 : this.classList.contains("comment-tray") ? 0 : this.parentElement?.querySelector(":scope > .comment-tray") === this ? 0 : columnH;
    return { x: 0, y: 0, top: 0, left: 0, right: 400, bottom: h, width: 400, height: h, toJSON: () => ({}) } as DOMRect;
  });
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
  useCommentStore.getState().reset();
  useServerStore.setState({ sessions: [makeSession({ id: "s1", name: "main" })], worktrees: [] } as never);
  useWorkspaceStore.setState({ activeSessionId: null } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("clampTrayHeight", () => {
  it("clamps between min and max; a column too short for both shrinks the list, never below 0", () => {
    expect(clampTrayHeight(50, 120, 500)).toBe(120);
    expect(clampTrayHeight(900, 120, 500)).toBe(500);
    expect(clampTrayHeight(300, 120, 500)).toBe(300);
    expect(clampTrayHeight(300, 120, 80)).toBe(80);
    expect(clampTrayHeight(300, 120, -20)).toBe(0);
  });
});

describe("tray resize handle", () => {
  it("has no separator while collapsed; expanded it is a horizontal separator with value, min and max", () => {
    seed();
    mount();
    expect(screen.queryByRole("separator")).toBeNull();
    expand();
    const h = handle();
    expect(h).toHaveAttribute("aria-orientation", "horizontal");
    expect(h).toHaveAttribute("tabindex", "0");
    // default min(424, 60vh = 540) = 424; max = 800 - 40 (strip) - 2 (borders) - 131 (35 tab bar + 96 preview) = 627
    expect(h).toHaveAttribute("aria-valuenow", "424");
    expect(h).toHaveAttribute("aria-valuemin", "120");
    expect(h).toHaveAttribute("aria-valuemax", "627");
    expect(heightOf()).toBe(424);
  });

  it("keys: ArrowUp +16, ArrowDown -16, PageUp/PageDown 64, Home = min, End = max; each is stored", () => {
    seed();
    mount();
    expand();
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(heightOf()).toBe(440);
    expect(localStorage.getItem(TRAY_HEIGHT_KEY)).toBe("440");
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(heightOf()).toBe(408);
    fireEvent.keyDown(handle(), { key: "PageUp" });
    expect(heightOf()).toBe(472);
    fireEvent.keyDown(handle(), { key: "PageDown" });
    expect(heightOf()).toBe(408);
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(heightOf()).toBe(120);
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(heightOf()).toBe(120); // clamped at min
    fireEvent.keyDown(handle(), { key: "End" });
    expect(heightOf()).toBe(627);
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(heightOf()).toBe(627); // clamped at max: the preview keeps its tab bar + 96px
    expect(handle()).toHaveAttribute("aria-valuenow", "627");
  });

  it("a column shrink re-clamps without writing storage and a regrow restores the stored size", () => {
    seed();
    mount();
    expand();
    fireEvent.keyDown(handle(), { key: "End" });
    expect(localStorage.getItem(TRAY_HEIGHT_KEY)).toBe("627");
    const writes = vi.spyOn(Storage.prototype, "setItem");
    columnH = 500;
    act(() => roCallbacks.forEach((cb) => (cb as (e: unknown[]) => void)([])));
    expect(heightOf()).toBe(327); // 500 - 40 - 2 - 131
    expect(localStorage.getItem(TRAY_HEIGHT_KEY)).toBe("627");
    columnH = 300; // too short for min: the list shrinks below 120 rather than the preview
    act(() => roCallbacks.forEach((cb) => (cb as (e: unknown[]) => void)([])));
    expect(heightOf()).toBe(127);
    columnH = 800;
    act(() => roCallbacks.forEach((cb) => (cb as (e: unknown[]) => void)([])));
    expect(heightOf()).toBe(627);
    expect(writes).not.toHaveBeenCalled();
  });

  it("pointer drag up grows the list live, persists on release and sets body styles only during the drag", () => {
    seed();
    mount();
    expand();
    const setCapture = vi.fn();
    (handle() as unknown as { setPointerCapture: () => void }).setPointerCapture = setCapture;
    pointer("pointerDown", handle(), { clientY: 600 });
    expect(setCapture).toHaveBeenCalledWith(1);
    expect(document.body.style.cursor).toBe("row-resize");
    expect(document.body.style.userSelect).toBe("none");
    pointer("pointerMove", window, { clientY: 450 });
    flushFrames();
    expect(heightOf()).toBe(574); // 424 + 150
    expect(localStorage.getItem(TRAY_HEIGHT_KEY)).toBeNull(); // not stored mid-drag
    pointer("pointerUp", window, { clientY: 450 });
    expect(localStorage.getItem(TRAY_HEIGHT_KEY)).toBe("574");
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("a drag past either edge clamps to max / min", () => {
    seed();
    mount();
    expand();
    pointer("pointerDown", handle(), { clientY: 600 });
    pointer("pointerMove", window, { clientY: -2000 });
    flushFrames();
    expect(heightOf()).toBe(627);
    pointer("pointerMove", window, { clientY: 5000 });
    flushFrames();
    expect(heightOf()).toBe(120);
    pointer("pointerUp", window, { clientY: 5000 });
    expect(localStorage.getItem(TRAY_HEIGHT_KEY)).toBe("120");
  });

  it("pointercancel restores the start height and stores nothing", () => {
    seed();
    mount();
    expand();
    pointer("pointerDown", handle(), { clientY: 600 });
    pointer("pointerMove", window, { clientY: 500 });
    flushFrames();
    expect(heightOf()).toBe(524);
    pointer("pointerCancel", window, { clientY: 500 });
    expect(heightOf()).toBe(424);
    expect(localStorage.getItem(TRAY_HEIGHT_KEY)).toBeNull();
    expect(document.body.style.cursor).toBe("");
  });

  it("double-click resets to the default and clears the key; so do two quick taps", () => {
    seed();
    mount();
    expand();
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(heightOf()).toBe(120);
    fireEvent.doubleClick(handle());
    expect(heightOf()).toBe(424);
    expect(localStorage.getItem(TRAY_HEIGHT_KEY)).toBeNull();

    fireEvent.keyDown(handle(), { key: "Home" });
    pointer("pointerDown", handle(), { clientY: 600 });
    pointer("pointerUp", window, { clientY: 600, timeStamp: 1000 });
    expect(heightOf()).toBe(120); // one tap alone changes nothing
    pointer("pointerDown", handle(), { clientY: 600 });
    pointer("pointerUp", window, { clientY: 601, timeStamp: 1200 });
    expect(heightOf()).toBe(424);
    expect(localStorage.getItem(TRAY_HEIGHT_KEY)).toBeNull();
  });

  it("two taps more than 300ms apart do not reset", () => {
    seed();
    mount();
    expand();
    fireEvent.keyDown(handle(), { key: "Home" });
    pointer("pointerDown", handle(), { clientY: 600 });
    pointer("pointerUp", window, { clientY: 600, timeStamp: 1000 });
    pointer("pointerDown", handle(), { clientY: 600 });
    pointer("pointerUp", window, { clientY: 600, timeStamp: 1500 });
    expect(heightOf()).toBe(120);
  });

  it("the size persists across a remount and survives collapse and expand", () => {
    seed();
    const first = mount();
    expand();
    fireEvent.keyDown(handle(), { key: "PageUp" });
    expect(heightOf()).toBe(488);
    fireEvent.click(screen.getByRole("button", { name: /^2 comments$/ }));
    expand();
    expect(heightOf()).toBe(488);
    first.unmount();
    mount();
    expand();
    expect(heightOf()).toBe(488);
  });

  it("corrupt storage falls back to the default; a storage that throws still renders", () => {
    localStorage.setItem(TRAY_HEIGHT_KEY, "banana");
    expect(readStoredTrayHeight()).toBeNull();
    seed();
    mount();
    expand();
    expect(heightOf()).toBe(424);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(heightOf()).toBe(440); // applied for this session even though it can't be stored
  });

  it("Esc still collapses the list and keeps the size", () => {
    seed();
    mount();
    expand();
    fireEvent.keyDown(handle(), { key: "PageUp" });
    expect(screen.getByRole("separator")).toBeInTheDocument();
    act(() => {
      dismissTop();
    });
    expect(screen.queryByRole("separator")).toBeNull();
    expect(localStorage.getItem(TRAY_HEIGHT_KEY)).toBe("488");
  });

  it("the 200-row virtualised list renders more rows once the list grows", async () => {
    const many = Array.from({ length: 200 }, (_, i) => c({ id: `r${i}`, pin: i + 1, path: `f${i}.ts` }));
    // the list scroller takes the list's inline height, as in a browser
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const parentH = this.parentElement?.classList.contains("comment-tray__list") ? Number.parseFloat(this.parentElement.style.height) : 0;
      const h = this.classList.contains("comment-list") ? parentH : this.classList.contains("comment-tray__strip") ? 40 : this.classList.contains("comment-list__virtual") ? 76 : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: 400, bottom: h, width: 400, height: h, toJSON: () => ({}) } as DOMRect;
    });
    for (const prop of ["offsetHeight", "offsetWidth"] as const) {
      vi.spyOn(HTMLElement.prototype, prop, "get").mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("comment-list")) return prop === "offsetHeight" ? Number.parseFloat(this.parentElement!.style.height) : 400;
        return this.classList.contains("comment-list__virtual") ? (prop === "offsetHeight" ? 76 : 400) : 0;
      });
    }
    seed(many);
    mount();
    expand();
    const resized = () => act(() => roCallbacks.forEach((cb) => (cb as (e: unknown[]) => void)([])));
    fireEvent.keyDown(handle(), { key: "Home" });
    resized();
    await waitFor(() => expect(document.querySelectorAll("[data-comment-row]").length).toBeGreaterThan(0));
    const small = document.querySelectorAll("[data-comment-row]").length;
    fireEvent.keyDown(handle(), { key: "PageUp" });
    fireEvent.keyDown(handle(), { key: "PageUp" });
    fireEvent.keyDown(handle(), { key: "PageUp" });
    resized();
    await waitFor(() => expect(document.querySelectorAll("[data-comment-row]").length).toBeGreaterThan(small));
  });
});
