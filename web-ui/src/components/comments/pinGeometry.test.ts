import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { endCharRange, groupPins, lineCenterY, measurePin, samePlacements } from "./pinGeometry";

const rect = (top: number, height = 20): DOMRect => ({ top, height, bottom: top + height, left: 0, right: 10, width: 10, x: 0, y: top, toJSON: () => {} }) as DOMRect;

beforeAll(() => {
  // jsdom has no layout: give Range the rect API so a test can stub it.
  const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList; getBoundingClientRect?: () => DOMRect };
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => rect(0, 0);
});
afterEach(() => vi.restoreAllMocks());

function textEl(text: string): HTMLElement {
  const el = document.createElement("span");
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

describe("endCharRange", () => {
  it("covers the last visible character, skipping trailing whitespace", () => {
    const el = textEl("hello   ");
    expect(endCharRange(el, 8)!.toString()).toBe("o");
  });

  it("covers a ZWJ emoji sequence as ONE range", () => {
    const el = textEl("ab 👩‍💻");
    expect(endCharRange(el, el.textContent!.length)!.toString()).toBe("👩‍💻");
  });

  it("covers a flag (two regional indicators) and a combining sequence as one unit", () => {
    expect(endCharRange(textEl("x🇩🇪"), 5)!.toString()).toBe("🇩🇪");
    expect(endCharRange(textEl("é"), 2)!.toString()).toBe("é");
  });

  it("RTL text: the logical-last character, not the visually rightmost", () => {
    const el = textEl("abc שלום");
    expect(endCharRange(el, el.textContent!.length)!.toString()).toBe("ם");
  });

  it("clamps an endCol beyond the text; all whitespace (or empty) has no range", () => {
    expect(endCharRange(textEl("abc"), 99)!.toString()).toBe("c");
    expect(endCharRange(textEl("   "), 3)).toBeNull();
    expect(endCharRange(textEl(""), 0)).toBeNull();
  });

  it("ends in the character's own node across token spans", () => {
    const el = document.createElement("span");
    el.innerHTML = "<i>foo</i><b>bar</b>";
    document.body.appendChild(el);
    const r = endCharRange(el, 6)!;
    expect(r.toString()).toBe("r");
    expect(r.endContainer.parentElement!.tagName).toBe("B");
  });
});

describe("lineCenterY", () => {
  it("uses the LAST client rect (the last visual line) and ignores empty rects", () => {
    const r = document.createRange();
    vi.spyOn(r, "getClientRects").mockReturnValue([rect(0), rect(20), rect(40, 0)] as unknown as DOMRectList);
    expect(lineCenterY(r)).toBe(30);
  });
  it("is null with no rects", () => {
    const r = document.createRange();
    vi.spyOn(r, "getClientRects").mockReturnValue([] as unknown as DOMRectList);
    expect(lineCenterY(r)).toBeNull();
  });
});

describe("measurePin", () => {
  function host(height = 100) {
    const h = document.createElement("div");
    const t = document.createElement("span");
    t.style.lineHeight = "20px";
    t.textContent = "some wrapped text";
    h.appendChild(t);
    document.body.appendChild(h);
    vi.spyOn(h, "getBoundingClientRect").mockReturnValue(rect(100, height));
    vi.spyOn(t, "getBoundingClientRect").mockReturnValue(rect(100, height));
    Object.defineProperty(h, "clientHeight", { value: height, configurable: true });
    return { h, t };
  }
  const stubLast = (cy: number) =>
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([rect(cy - 10)] as unknown as DOMRectList);

  it("centres on the line of the last character: line 3 of a 5-line host -> 2.5*lh - 8", () => {
    const { h, t } = host();
    stubLast(150); // centre of visual line 3 (top 140)
    expect(measurePin(h, t, t.textContent!.length, 16)).toBe(42);
  });

  it("clamps at the top and at the bottom of the host", () => {
    const { h, t } = host();
    stubLast(101);
    expect(measurePin(h, t, 5, 16)).toBe(0);
    stubLast(5000);
    expect(measurePin(h, t, 5, 16)).toBe(84);
  });

  it("no rects (hidden / blank): the first visual line of the row", () => {
    const { h, t } = host();
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([] as unknown as DOMRectList);
    expect(measurePin(h, t, 5, 16)).toBe(2); // 100 + 20/2 - 100 - 8
  });

  it("endCol null: the last visual line of the row's text; an end element wins over a column", () => {
    const { h, t } = host();
    stubLast(130);
    expect(measurePin(h, t, null, 16)).toBe(22);
    const mark = document.createElement("mark");
    h.appendChild(mark);
    vi.spyOn(mark, "getClientRects").mockReturnValue([rect(160)] as unknown as DOMRectList);
    expect(measurePin(h, t, 3, 16, mark)).toBe(62);
  });
});

describe("groupPins", () => {
  const p = (id: string, pin: number, top: number) => ({ id, pin, top });
  it("equal tops form one group ordered by pin number", () => {
    expect(groupPins([p("b", 2, 10), p("a", 1, 10)], 16)).toEqual([{ top: 10, ids: ["a", "b"] }]);
  });
  it("16px pins 10px apart merge, 20px apart stay separate", () => {
    expect(groupPins([p("a", 1, 0), p("b", 2, 10)], 16)).toHaveLength(1);
    expect(groupPins([p("a", 1, 0), p("b", 2, 20)], 16)).toHaveLength(2);
  });
  it("the coarse distance is 24px", () => {
    expect(groupPins([p("a", 1, 0), p("b", 2, 20)], 24)).toHaveLength(1);
    expect(groupPins([p("a", 1, 0), p("b", 2, 24)], 24)).toHaveLength(2);
  });
  it("the group sits at its first member's top and compares against that top", () => {
    const g = groupPins([p("c", 3, 30), p("a", 1, 0), p("b", 2, 12)], 16);
    expect(g).toEqual([{ top: 0, ids: ["a", "b"] }, { top: 30, ids: ["c"] }]);
  });
  it("samePlacements compares tops and members", () => {
    expect(samePlacements([{ top: 1, ids: ["a"] }], [{ top: 1, ids: ["a"] }])).toBe(true);
    expect(samePlacements([{ top: 1, ids: ["a"] }], [{ top: 2, ids: ["a"] }])).toBe(false);
    expect(samePlacements([{ top: 1, ids: ["a"] }], [{ top: 1, ids: ["b"] }])).toBe(false);
  });
});
