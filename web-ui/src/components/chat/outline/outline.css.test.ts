import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BEAT_ROW_H, OUTLINE_NARROW_QUERY, TOUCH_BEAT_ROW_H, TOUCH_TURN_ROW_H, TURN_ROW_H } from "./TurnOutlinePanel";

describe("outline.css", () => {
  const cssContent = readFileSync(resolve(__dirname, "outline.css"), "utf-8");
  const rule = (selector: string): string => {
    const m = cssContent.match(new RegExp(`\\n${selector.replace(/[.()[\]>*+?^$|\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    expect(m, selector).not.toBeNull();
    return m![1]!;
  };
  const block = (query: string): string => {
    const m = cssContent.match(new RegExp(`@media ${query.replace(/[()]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\n\\}`));
    expect(m, query).not.toBeNull();
    return m![1]!;
  };

  it("contains no bare hex colours", () => {
    const stripped = cssContent.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });

  it("uses only defined tokens", () => {
    const tokensContent = readFileSync(resolve(__dirname, "../../../styles/tokens.css"), "utf-8");
    const defined = new Set<string>();
    for (const m of tokensContent.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) defined.add(m[1]!);
    for (const m of cssContent.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) defined.add(m[1]!);
    const missing = [...cssContent.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map((m) => m[1]!).filter((v) => !defined.has(v));
    expect(missing).toEqual([]);
  });

  it("the panel sits beside the chain, 40px down (below the pane controls), 344px wide, hugging its content", () => {
    const olp = rule(".olp");
    expect(olp).toMatch(/left:\s*24px/);
    expect(olp).toMatch(/top:\s*40px/);
    expect(olp).toMatch(/bottom:\s*auto/);
    expect(olp).toMatch(/width:\s*min\(344px, calc\(100% - 40px\)\)/);
    expect(olp).toMatch(/max-height:\s*calc\(100% - 48px\)/);
    expect(rule(".olp__scroll")).toMatch(/flex:\s*0 1 auto/);
    expect(rule(".olp__head")).toMatch(/height:\s*40px/);
    expect(rule(".chat-pane[data-find-open] .olp")).toMatch(/top:\s*calc\(var\(--find-bar-h, 44px\) \+ 12px\)/);
    // The normal panel never hides the pane controls: it starts below them (the compact
    // variant does reach them and hides the overlay instead; see the test below).
  });

  it("the compact panel hides the pane's floating controls, which paint above the viewport's stacking context", () => {
    const sel = ".chat-pane:not([data-find-open]):has(.olp--compact) .chat-font-overlay";
    const body = rule(sel);
    expect(body).toMatch(/visibility:\s*hidden/);
    // visibility, not display: no layout change, and hidden buttons leave the tab order.
    expect(body).not.toMatch(/display:\s*none/);
    // Declared after the compact rule it depends on; the find bar's own overlay rules stay untouched.
    expect(cssContent.indexOf(sel)).toBeGreaterThan(cssContent.indexOf(".olp--compact"));
  });

  it("row heights match the virtualizer's constants: 32 / 26 on desktop, 44 by touch and under the narrow query", () => {
    expect([TURN_ROW_H, BEAT_ROW_H, TOUCH_TURN_ROW_H, TOUCH_BEAT_ROW_H]).toEqual([32, 26, 44, 44]);
    expect(rule(".olp__row")).toMatch(/height:\s*32px/);
    expect(rule(".olp__beat")).toMatch(/height:\s*26px/);
    expect(rule(".olp--touch .olp__row,\n.olp--touch .olp__beat")).toMatch(/height:\s*44px/);
    const narrow = block(OUTLINE_NARROW_QUERY);
    expect(narrow).toMatch(/\.olp__row\s*\{\s*height:\s*44px;/);
    expect(narrow).toMatch(/\.olp__beat\s*\{\s*height:\s*44px;/);
  });

  it("steps hang on a 1px rail in a glyph column as wide as the number column", () => {
    expect(rule(".olp__gl")).toMatch(/width:\s*var\(--olp-n-w, 20px\)/);
    expect(rule(".olp__n")).toMatch(/width:\s*var\(--olp-n-w, 20px\)/);
    expect(rule(".olp__gl::before,\n.olp__gl::after")).toMatch(/width:\s*1px/);
  });

  it("red only on the error glyph and the error count; times are muted micro text", () => {
    expect(rule(".olp__chip--err")).toMatch(/color:\s*var\(--fg-danger\)/);
    expect(cssContent).toMatch(/\.k-error \.olp__gl \{ color: var\(--map-error\); \}/);
    const time = rule(".olp__time");
    expect(time).toMatch(/font-size:\s*var\(--fs-micro\)/);
    expect(time).toMatch(/color:\s*var\(--fg-muted\)/);
    expect(time).toMatch(/white-space:\s*nowrap/);
    expect(time).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it("the open list never covers the chain: it starts right of the hit strip, the chain stacks above it, no button state fills the strip", () => {
    const px = (body: string, prop: string): number => {
      const m = body.match(new RegExp(`(?:^|\\n)\\s*${prop}:\\s*(-?\\d+)px`));
      expect(m, prop).not.toBeNull();
      return Number(m![1]);
    };
    const z = (body: string): number => Number(body.match(/z-index:\s*(\d+)/)![1]);
    const ol = rule(".ol");
    const btn = rule(".chainbtn");
    // Pane x of the chain's right edge: the wider of the lines box and the hit strip.
    const chainRight = px(ol, "left") + Math.max(px(ol, "width"), px(btn, "left") + px(btn, "width"));
    expect(px(rule(".olp"), "left")).toBeGreaterThanOrEqual(chainRight);
    expect(z(rule(".ol--open"))).toBeGreaterThan(z(rule(".olp")));
    expect(rule(".chainbtn:hover,\n.chainbtn:active,\n.chainbtn:focus")).toMatch(/background:\s*transparent/);
    expect(z(rule(".ol__marks"))).toBeGreaterThan(0);
    expect(z(rule(".ol__scrub"))).toBeGreaterThan(0);
    for (const sel of [".ol", ".ol--open", ".ol__marks", ".chainbtn"]) {
      expect(rule(sel), sel).not.toMatch(/opacity|visibility|display:\s*none/);
    }
  });

  it("labels use the whole row up to the chips and the right-edge time column; nothing reserves a gutter", () => {
    const label = rule(".olp__label");
    expect(label).toMatch(/flex:\s*1 1 auto/);
    expect(label).toMatch(/min-width:\s*0/);
    expect(label).not.toMatch(/max-width/);
    const rowPad = rule(".olp__row").match(/padding:\s*([^;]+);/)![1];
    expect(rowPad).toBe("0 var(--space-2)");
    expect(rule(".olp__beat").match(/padding:\s*([^;]+);/)![1]).toBe(rowPad);
    expect(rule(".olp__beat")).toMatch(/min-width:\s*0/);
    expect(rule(".olp__beats")).toMatch(/min-width:\s*0/);
    expect(rule(".olp__item")).toMatch(/min-width:\s*0/);
    expect(cssContent).not.toMatch(/padding-right/);
    expect(cssContent).not.toMatch(/olp__chev|olp__steps|beats-wrap/);
    const time = rule(".olp__time");
    expect(time).toMatch(/flex:\s*none/);
    expect(time).toMatch(/min-width:\s*32px/);
    expect(time).toMatch(/text-align:\s*right/);
  });

  it("the chain is a hit strip that never pans, around lines drawn by one SVG", () => {
    const btn = rule(".chainbtn");
    expect(btn).toMatch(/width:\s*24px/);
    expect(btn).toMatch(/touch-action:\s*none/);
    expect(rule(".ol__marks")).toMatch(/pointer-events:\s*none/);
    expect(cssContent).not.toMatch(/\.nd\b|\.bt\b/);
  });

  it("a short chain's compact panel hugs the viewport, declared before the find-open offset", () => {
    const compact = rule(".olp--compact");
    expect(compact).toMatch(/top:\s*4px/);
    expect(compact).toMatch(/max-height:\s*calc\(100% - 8px\)/);
    // The find bar's offset must still win over the compact top.
    expect(cssContent.indexOf(".olp--compact")).toBeLessThan(
      cssContent.indexOf(".chat-pane[data-find-open] .olp"),
    );
  });

  it("the jump flash tints the target, fades over 600ms, and drops the fade under reduced motion", () => {
    expect(rule("[data-jump-flash]")).toMatch(/transition:\s*background-color 600ms/);
    expect(cssContent).toMatch(/\[data-jump-flash="on"\]\s*\{[^}]*background-color:\s*color-mix\(in srgb, var\(--accent\) 12%, transparent\)/);
    const reduced = block("(prefers-reduced-motion: reduce)");
    expect(reduced).toContain("[data-jump-flash]");
    expect(reduced).toMatch(/\.olp\s*\{[^}]*animation:\s*none !important/);
  });
});
