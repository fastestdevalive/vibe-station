import { describe, expect, it } from "vitest";
import { showInvisibles } from "./visibleText";

describe("showInvisibles", () => {
  it("shows bidi and zero-width characters literally and drops control characters", () => {
    expect(showInvisibles("a‮b​c\u0007d\n")).toBe("a<U+202E>b<U+200B>cd\n");
  });
  it("covers the other invisible ranges and C1/DEL", () => {
    expect(showInvisibles("؜﻿⁦\u007F\u0085x")).toBe("<U+061C><U+FEFF><U+2066>x");
  });
  it("passes plain text, tabs and newlines through unchanged", () => {
    expect(showInvisibles("plain\ttext\nline é 日本")).toBe("plain\ttext\nline é 日本");
  });
  it("shows tag characters, variation selectors and the other hidden format characters (review 20)", () => {
    const tagA = String.fromCodePoint(0xe0041);
    const vs17 = String.fromCodePoint(0xe0100);
    expect(showInvisibles(`a${tagA}b`)).toBe("a<U+E0041>b");
    expect(showInvisibles(`x\uFE0Fy${vs17}`)).toBe("x<U+FE0F>y<U+E0100>");
    expect(showInvisibles("\u034F\u115F\u1160\u3164\uFFA0\uFFF9\u00AD")).toBe(
      "<U+034F><U+115F><U+1160><U+3164><U+FFA0><U+FFF9><U+00AD>",
    );
  });
  it("leaves emoji presentation selectors and ZWJ sequences alone (P-07)", () => {
    for (const s of ["⚠️ this leaks", "✔️ ok", "\u{1F469}‍\u{1F4BB}", "❤️‍\u{1F525}", "\u{1F469}\u{1F3FD}‍\u{1F4BB}"]) {
      expect(showInvisibles(s)).toBe(s);
    }
  });
  it("still shows a lone, leading or text-adjacent selector/ZWJ and bidi controls", () => {
    expect(showInvisibles("️")).toBe("<U+FE0F>");
    expect(showInvisibles("‍a")).toBe("<U+200D>a");
    expect(showInvisibles("a‍b")).toBe("a<U+200D>b");
    expect(showInvisibles("\u{1F600}​️")).toBe("\u{1F600}<U+200B><U+FE0F>");
    expect(showInvisibles("\u{1F600}‍")).toBe("\u{1F600}<U+200D>");
    expect(showInvisibles("a‮b")).toBe("a<U+202E>b");
  });
});
