import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("find.css", () => {
  const cssPath = resolve(__dirname, "find.css");
  const cssContent = readFileSync(cssPath, "utf-8");

  it("contains prefers-reduced-motion block", () => {
    expect(cssContent).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("contains 420px container query rule", () => {
    expect(cssContent).toMatch(/@container\s*\(max-width:\s*420px\)/);
  });

  it("contains 640px media query rule", () => {
    expect(cssContent).toMatch(/@media\s*\(max-width:\s*640px\)/);
  });

  it("contains no bare hex color literals", () => {
    const stripped = cssContent.replace(/\/\*[\s\S]*?\*\//g, "");
    const hexPattern = /#[0-9a-fA-F]{3,8}\b/g;
    const matches = stripped.match(hexPattern);
    expect(matches).toBeNull();
  });

  it("uses only defined tokens (no undefined var(--x) references)", () => {
    const tokensPath = resolve(__dirname, "../../../styles/tokens.css");
    const tokensContent = readFileSync(tokensPath, "utf-8");

    const definedTokens = new Set<string>();
    for (const m of tokensContent.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) {
      definedTokens.add(m[1]!);
    }
    for (const m of cssContent.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) {
      definedTokens.add(m[1]!);
    }

    const undefinedTokens: string[] = [];
    for (const m of cssContent.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
      const varName = m[1]!;
      if (!definedTokens.has(varName)) {
        undefinedTokens.push(varName);
      }
    }
    expect(undefinedTokens).toEqual([]);
  });

  it("sizes the results popover against the pane, never a percentage of the bar host", () => {
    const fpopBlocks = [...cssContent.matchAll(/\.fpop\s*\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(fpopBlocks.length).toBeGreaterThan(0);
    for (const block of fpopBlocks) {
      // `max-height: 60%` resolved against the 56px `.fbar-host`, making the
      // phone list ~34px tall.
      expect(block).not.toMatch(/max-height:\s*[\d.]+%/);
    }
    // Both the desktop and the phone rule must use container-query units
    // (`cqh`), which resolve against `.chat-pane__viewport`'s size container.
    expect(fpopBlocks.some((block) => /max-height:\s*[^;]*cqh/.test(block))).toBe(true);
  });

  it("640px media query contains four-selector display: none rule with .fbar prefix", () => {
    const mediaMatch = cssContent.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/);
    expect(mediaMatch).not.toBeNull();
    const mediaBlock = mediaMatch![1]!;
    expect(mediaBlock).toMatch(
      /\.fbar\s+\.fpill,\s*\.fbar\s+\.fbar__sep,\s*\.fbar\s+\.fbar__list-btn,\s*\.fbar\s+\.fbar__more-btn\s*\{\s*display:\s*none;?\s*\}/,
    );
  });

  it("asserts anchor scroll-margin-top and :has(.fpop) cqh rules exist", () => {
    expect(cssContent).toMatch(
      /\.chat-pane\[data-find-open\]\s+\[data-find-anchor\]\s*\{[^}]*scroll-margin-top:\s*calc\(var\(--find-bar-h\)\s*\+\s*16px\);?[^}]*\}/,
    );

    const fpopScrollRule = cssContent.match(
      /\.chat-pane__viewport:has\(\.fpop\)\s+mark\.find-hit,\s*\.chat-pane__viewport:has\(\.fpop\)\s+\[data-find-anchor\]\s*\{([^}]*)\}/,
    );
    expect(fpopScrollRule).not.toBeNull();
    const ruleBody = fpopScrollRule![1]!;
    expect(ruleBody).toContain("cqh");
    expect(ruleBody).not.toMatch(/scroll-margin-top:[^;]*%/);
  });
});
