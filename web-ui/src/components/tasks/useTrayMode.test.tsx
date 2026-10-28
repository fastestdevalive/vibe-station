import { StrictMode, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTrayMode, type UseTrayModeOpts } from "./useTrayMode";
import type { TaskClass } from "./trayMode";

let root: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement("div");
  root.innerHTML = '<button id="row">row</button><button id="dot" data-tray-toggle data-active="true">dot</button>';
  document.body.appendChild(root);
  const orig = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, sel: string) {
    return sel === ":focus-visible" ? this.hasAttribute("data-fv") : orig.call(this, sel);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  root.remove();
});

type Props = Partial<UseTrayModeOpts> & { cls?: TaskClass | undefined };
function setup(initial: Props = {}, wrapper?: ({ children }: { children: ReactNode }) => ReactNode) {
  const onWritePref = vi.fn();
  const focusComposer = vi.fn();
  const base = (p: Props): UseTrayModeOpts => ({
    sessionId: "s1",
    cls: "finished",
    pref: "strip",
    viewOpen: false,
    onWritePref,
    focusComposer,
    rootRef: { current: root },
    ...p,
  });
  const hook = renderHook((p: Props) => useTrayMode(base(p)), { initialProps: initial, ...(wrapper ? { wrapper } : {}) });
  return { ...hook, onWritePref, focusComposer, ev: (type: string, extra = {}) => act(() => hook.result.current.dispatch({ type, ...extra } as never)) };
}
const ms = (n: number) => act(() => void vi.advanceTimersByTime(n));
const kd = (key: string, target: Element = root) => ({ key, target, defaultPrevented: false, nativeEvent: { isComposing: false }, preventDefault() {}, stopPropagation() {} }) as never;

describe("useTrayMode", () => {
  it("2.T1 finished -> dot; tapDot -> strip (never the bar); 4999 keeps, 5000 returns to the dot", () => {
    const h = setup();
    expect(h.result.current.mode).toBe("dot");
    h.ev("tapDot");
    expect(h.result.current.mode).toBe("strip");
    ms(4999);
    expect(h.result.current.mode).toBe("strip");
    ms(1);
    expect(h.result.current.mode).toBe("dot");
  });

  it("2.T2 second tap opens the bar and leaves no timer", () => {
    const h = setup();
    h.ev("tapDot");
    h.ev("tapStrip");
    expect(h.result.current.mode).toBe("bar");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("2.T3 hover pauses; leaving restarts a full 5 s", () => {
    const h = setup();
    h.ev("tapDot");
    ms(3000);
    act(() => h.result.current.rootHandlers.onPointerEnter({ pointerType: "mouse" } as never));
    ms(20_000);
    expect(h.result.current.mode).toBe("strip");
    act(() => h.result.current.rootHandlers.onPointerLeave({ pointerType: "mouse" } as never));
    ms(4999);
    expect(h.result.current.mode).toBe("strip");
    ms(1);
    expect(h.result.current.mode).toBe("dot");
  });

  it("touch pointer events never hold", () => {
    const h = setup();
    h.ev("tapDot");
    act(() => h.result.current.rootHandlers.onPointerEnter({ pointerType: "touch" } as never));
    ms(5000);
    expect(h.result.current.mode).toBe("dot");
  });

  it("2.T4 poke at 4 s restarts; list onScroll pokes; root has no onScroll", () => {
    const h = setup();
    h.ev("tapDot");
    ms(4000);
    act(() => h.result.current.rootHandlers.onPointerDown());
    ms(4999);
    expect(h.result.current.mode).toBe("strip");
    act(() => h.result.current.listHandlers.onScroll());
    ms(4999);
    expect(h.result.current.mode).toBe("strip");
    ms(1);
    expect(h.result.current.mode).toBe("dot");
    expect("onScroll" in h.result.current.rootHandlers).toBe(false);
  });

  it("2.T5 a new task cancels the countdown (strip stays strip; dot -> strip/bar per pref)", () => {
    const h = setup();
    h.ev("tapDot");
    h.rerender({ cls: "active" });
    expect(h.result.current.mode).toBe("strip");
    expect(vi.getTimerCount()).toBe(0);
    const d = setup({ pref: "bar" });
    d.rerender({ cls: "active", pref: "bar" });
    expect(d.result.current.mode).toBe("bar");
    const s = setup();
    s.rerender({ cls: "active" });
    expect(s.result.current.mode).toBe("strip");
  });

  it("2.T6 last task finishing: strip and unpinned bar fall to the dot after 5 s; holds pause", () => {
    const h = setup({ cls: "active" });
    expect(h.result.current.mode).toBe("strip");
    act(() => h.result.current.rootHandlers.onPointerEnter({ pointerType: "mouse" } as never));
    h.rerender({ cls: "finished" });
    ms(10_000);
    expect(h.result.current.mode).toBe("strip");
    act(() => h.result.current.rootHandlers.onPointerLeave({ pointerType: "mouse" } as never));
    ms(5000);
    expect(h.result.current.mode).toBe("dot");
    const b = setup({ cls: "active", pref: "bar" });
    b.rerender({ cls: "finished", pref: "bar" });
    ms(5000);
    expect(b.result.current.mode).toBe("dot");
    const p = setup({ cls: "active" });
    p.ev("tapStrip");
    p.rerender({ cls: "finished" });
    ms(60_000);
    expect(p.result.current.mode).toBe("bar");
  });

  it("2.T7 unknown then the same class again: no mode change, no new timer", () => {
    const h = setup({ cls: "active" });
    const spy = vi.spyOn(globalThis, "setTimeout");
    h.rerender({ cls: undefined });
    h.rerender({ cls: "active" });
    expect(h.result.current.mode).toBe("strip");
    expect(spy).not.toHaveBeenCalled();
  });

  it("2.T8 session switch re-inits, clears the timer and seeds ambient holds", () => {
    const h = setup();
    h.ev("tapDot");
    h.rerender({ sessionId: "s2", cls: "active" });
    expect(h.result.current.mode).toBe("strip");
    expect(vi.getTimerCount()).toBe(0);
    h.rerender({ sessionId: "s3", cls: "finished", viewOpen: true });
    expect(h.result.current.mode).toBe("dot");
    h.ev("tapDot");
    ms(30_000);
    expect(h.result.current.mode).toBe("strip");
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const d = setup();
    d.ev("tapDot");
    ms(30_000);
    expect(d.result.current.mode).toBe("strip");
  });

  it("2.T9 task view open holds; closing restarts a full 5 s", () => {
    const h = setup();
    h.ev("tapDot");
    h.rerender({ viewOpen: true });
    ms(30_000);
    expect(h.result.current.mode).toBe("strip");
    h.rerender({ viewOpen: false });
    ms(4999);
    expect(h.result.current.mode).toBe("strip");
    ms(1);
    expect(h.result.current.mode).toBe("dot");
  });

  it("2.T10 hidden tab pauses and resumes with a full restart", () => {
    const h = setup();
    h.ev("tapDot");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    ms(30_000);
    expect(h.result.current.mode).toBe("strip");
    hidden.mockReturnValue(false);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    ms(5000);
    expect(h.result.current.mode).toBe("dot");
  });

  it("2.T11 pref written only by strip tap / bar chevron while active", () => {
    const h = setup({ cls: "active" });
    h.ev("tapStrip");
    expect(h.onWritePref).toHaveBeenCalledWith("bar");
    h.ev("tapHeader");
    expect(h.onWritePref).toHaveBeenLastCalledWith("strip");
    h.onWritePref.mockClear();
    h.ev("tapStrip");
    h.onWritePref.mockClear();
    act(() => h.result.current.rootHandlers.onKeyDown(kd("Escape")));
    expect(h.onWritePref).not.toHaveBeenCalled();
    const d = setup();
    d.ev("tapDot");
    ms(5000);
    d.ev("tapStrip");
    expect(d.onWritePref).not.toHaveBeenCalled();
  });

  it("2.T12 unmount clears the timeout; StrictMode keeps the countdown alive", () => {
    const h = setup();
    h.ev("tapDot");
    h.unmount();
    expect(vi.getTimerCount()).toBe(0);
    const s = setup({}, ({ children }) => <StrictMode>{children}</StrictMode>);
    s.ev("tapDot");
    ms(5000);
    expect(s.result.current.mode).toBe("dot");
  });

  it("2.T13 Esc collapses bar -> strip and focuses the composer; ignored on dot/strip and in inputs", () => {
    const h = setup();
    act(() => h.result.current.rootHandlers.onKeyDown(kd("Escape")));
    expect(h.focusComposer).not.toHaveBeenCalled();
    h.ev("tapDot");
    act(() => h.result.current.rootHandlers.onKeyDown(kd("Escape")));
    expect(h.result.current.mode).toBe("strip");
    expect(h.focusComposer).not.toHaveBeenCalled();
    h.ev("tapStrip");
    const input = document.createElement("input");
    act(() => h.result.current.rootHandlers.onKeyDown(kd("Escape", input)));
    expect(h.result.current.mode).toBe("bar");
    act(() => h.result.current.rootHandlers.onKeyDown(kd("Escape")));
    expect(h.result.current.mode).toBe("strip");
  });

  it("2.T14 focus moves to the new toggle only when the focused node is leaving", () => {
    const h = setup();
    h.ev("tapDot");
    const row = root.querySelector<HTMLElement>("#row")!;
    row.focus();
    root.setAttribute("inert", ""); // the browser blurs/ignores focus in an inert subtree
    ms(5000);
    root.removeAttribute("inert");
    expect(h.result.current.mode).toBe("dot");
    expect(document.activeElement).not.toBe(row);
    const dot = root.querySelector<HTMLElement>("#dot")!;
    expect(document.activeElement === dot || document.activeElement === document.body).toBe(true);
    // Focus on a still-live node stays put.
    const h2 = setup();
    h2.ev("tapDot");
    row.focus();
    ms(5000);
    expect(document.activeElement).toBe(row);
  });

  it("2.T14b hidden with focus inside -> composer, except on coarse pointers", () => {
    const h = setup({ cls: "active" });
    root.querySelector<HTMLElement>("#row")!.focus();
    (document.activeElement as HTMLElement).blur();
    const row = root.querySelector<HTMLElement>("#row")!;
    row.focus();
    root.setAttribute("inert", "");
    h.rerender({ cls: "none" });
    root.removeAttribute("inert");
    expect(h.result.current.mode).toBe("hidden");
    expect(h.focusComposer).toHaveBeenCalledTimes(1);
    const coarse = vi.fn(() => ({ matches: true }));
    vi.stubGlobal("matchMedia", coarse);
    const t = setup({ cls: "active" });
    row.focus();
    root.setAttribute("inert", "");
    t.rerender({ cls: "none" });
    root.removeAttribute("inert");
    expect(t.focusComposer).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("2.T15 a stuck focus hold is repaired after the mode commit", () => {
    const h = setup();
    h.ev("tapDot");
    const row = root.querySelector<HTMLElement>("#row")!;
    row.setAttribute("data-fv", "");
    row.focus();
    act(() => h.result.current.rootHandlers.onFocus({ target: row } as never));
    ms(30_000);
    expect(h.result.current.mode).toBe("strip");
    row.blur(); // focus left without a focusout reaching React
    h.ev("tapStrip");
    h.ev("tapHeader");
    expect(h.result.current.mode).toBe("strip");
    ms(5000);
    expect(h.result.current.mode).toBe("dot");
  });
});
