import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PinMeasurer, type PinTarget } from "./pinMeasurer";

const rect = (top: number, height = 20): DOMRect => ({ top, height, bottom: top + height, left: 0, right: 10, width: 10, x: 0, y: top, toJSON: () => {} }) as DOMRect;

let log: string[];
beforeEach(() => {
  log = [];
  const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList; getBoundingClientRect?: () => DOMRect };
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => rect(0, 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function makeHost(name: string) {
  const host = document.createElement("div");
  const text = document.createElement("span");
  text.className = "t";
  text.textContent = "some text";
  host.appendChild(text);
  document.body.appendChild(host);
  vi.spyOn(host, "getBoundingClientRect").mockImplementation(() => {
    log.push(`read:${name}`);
    return rect(0, 100);
  });
  vi.spyOn(text, "getBoundingClientRect").mockReturnValue(rect(0, 20));
  Object.defineProperty(host, "clientHeight", { value: 100, configurable: true });
  return { host, text };
}

const targets: PinTarget[] = [{ id: "a", pin: 1, endCol: 4 }];

function register(m: PinMeasurer, name: string, apply = vi.fn(() => void log.push(`write:${name}`)), t: () => readonly PinTarget[] = () => targets) {
  const { host } = makeHost(name);
  const targetsFn = vi.fn(t);
  const handle = m.register({ host, textEl: () => host.querySelector<HTMLElement>(".t"), targets: targetsFn, apply });
  return { host, handle, apply, targetsFn };
}

describe("PinMeasurer", () => {
  it("reads every host before any write", () => {
    const m = new PinMeasurer();
    register(m, "one");
    register(m, "two");
    m.flush();
    const firstWrite = log.findIndex((l) => l.startsWith("write"));
    expect(firstWrite).toBeGreaterThan(0);
    expect(log.slice(0, firstWrite).every((l) => l.startsWith("read"))).toBe(true);
    expect(log.filter((l) => l.startsWith("write"))).toHaveLength(2);
    expect(log.slice(firstWrite).some((l) => l.startsWith("read"))).toBe(false);
  });

  it("does not call apply again when the placements are equal", () => {
    const m = new PinMeasurer();
    const { apply, handle } = register(m, "one");
    m.flush();
    handle.markDirty();
    m.flush();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("skips hosts the IntersectionObserver reports as off-screen, and measures them once they enter", () => {
    let cb: IntersectionObserverCallback = () => {};
    const observed: Element[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(c: IntersectionObserverCallback) {
          cb = c;
        }
        observe(el: Element) {
          observed.push(el);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const m = new PinMeasurer();
    m.attach(document.body);
    const { host, apply } = register(m, "far");
    expect(observed).toContain(host);
    m.flush();
    expect(apply).not.toHaveBeenCalled();
    cb([{ target: host, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    m.flush();
    expect(apply).toHaveBeenCalledTimes(1);
    m.detach();
  });

  it("marks everything dirty on a font load and on a theme attribute change", async () => {
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
    const m = new PinMeasurer();
    m.attach(document.body);
    const { targetsFn } = register(m, "one");
    m.flush();
    targetsFn.mockClear();
    m.flush();
    expect(targetsFn).not.toHaveBeenCalled(); // clean: nothing to read
    fonts.dispatchEvent(new Event("loadingdone"));
    m.flush();
    expect(targetsFn).toHaveBeenCalledTimes(1);
    targetsFn.mockClear();
    document.documentElement.setAttribute("data-theme", "vibestation-light");
    await Promise.resolve();
    m.flush();
    expect(targetsFn).toHaveBeenCalledTimes(1);
    document.documentElement.removeAttribute("data-theme");
    m.detach();
    Reflect.deleteProperty(document, "fonts");
  });

  it("unregisters a host on unmount", () => {
    const m = new PinMeasurer();
    const { handle } = register(m, "one");
    expect(m.hostCount).toBe(1);
    handle.unregister();
    expect(m.hostCount).toBe(0);
  });

  it("markdown mode: a pin hangs off the comment's end marker, and vanishes with it", () => {
    const m = new PinMeasurer();
    const { host, handle, apply } = register(m, "md", undefined, () => [{ id: "c1", pin: 1 }]);
    m.flush();
    expect(apply).not.toHaveBeenCalled(); // no marker: nothing to place, nothing changed
    const mark = document.createElement("mark");
    mark.setAttribute("data-comment-end", "");
    mark.setAttribute("data-comment-id", "c1");
    host.appendChild(mark);
    vi.spyOn(mark, "getClientRects").mockReturnValue([rect(40)] as unknown as DOMRectList);
    handle.markDirty();
    m.flush();
    expect(apply).toHaveBeenLastCalledWith([{ top: 42, ids: ["c1"] }]);
    mark.remove();
    handle.markDirty();
    m.flush();
    expect(apply).toHaveBeenLastCalledWith([]);
  });

  it("code stacks follow the scroll position: x = scrollLeft + clientWidth - gutter + (gutter - stackW) / 2", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    root.style.setProperty("--comment-gutter-w", "24px");
    Object.defineProperty(root, "clientWidth", { value: 800, configurable: true });
    let left = 0;
    Object.defineProperty(root, "scrollLeft", { get: () => left, configurable: true });
    const m = new PinMeasurer();
    m.attach(root);
    const stack = document.createElement("div");
    Object.defineProperty(stack, "offsetWidth", { value: 16, configurable: true });
    root.appendChild(stack);
    m.trackStack(stack);
    m.flush();
    expect(stack.style.getPropertyValue("--x")).toBe("780px");
    left = 500;
    root.dispatchEvent(new Event("scroll"));
    m.flush();
    expect(stack.style.getPropertyValue("--x")).toBe("1280px");
    m.detach();
  });
});
