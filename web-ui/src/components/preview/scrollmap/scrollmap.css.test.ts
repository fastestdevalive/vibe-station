import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("scrollmap.css", () => {
  const cssPath = resolve(__dirname, "scrollmap.css");
  const cssContent = readFileSync(cssPath, "utf-8");

  it("hides the native scrollbar under the marks track in every engine", () => {
    const block = cssContent.match(/\.preview-body--tracked\s*\{([^}]*)\}/);
    expect(block?.[1]).toMatch(/scrollbar-width:\s*none/);
    expect(cssContent).toMatch(/\.preview-body--tracked::-webkit-scrollbar\s*\{[^}]*width:\s*0/);
  });

  it("contains prefers-reduced-motion block", () => {
    expect(cssContent).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("contains no bare hex or rgb( color literals", () => {
    const stripped = cssContent.replace(/\/\*[\s\S]*?\*\//g, "");
    const hexPattern = /#[0-9a-fA-F]{3,8}\b/g;
    expect(stripped.match(hexPattern)).toBeNull();

    const rgbPattern = /rgba?\(/g;
    expect(stripped.match(rgbPattern)).toBeNull();
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

  it(".scrollmap-pixel-mark contains left: 1px and right: 1px", () => {
    const pixelMarkMatch = cssContent.match(/\.scrollmap-pixel-mark\s*\{([^}]*)\}/);
    expect(pixelMarkMatch).not.toBeNull();
    const body = pixelMarkMatch![1]!;
    expect(body).toMatch(/left:\s*1px;/);
    expect(body).toMatch(/right:\s*1px;/);
  });

  it("contains a .scrollmap-thumb::after rule with width: 6px", () => {
    const thumbAfterMatch = cssContent.match(/\.scrollmap-thumb::after\s*\{([^}]*)\}/);
    expect(thumbAfterMatch).not.toBeNull();
    const body = thumbAfterMatch![1]!;
    expect(body).toMatch(/width:\s*6px;/);
  });

  it("both containers declare touch-action: none", () => {
    const minimapMatch = cssContent.match(/\.scrollmap-minimap-container\s*\{([^}]*)\}/);
    expect(minimapMatch).not.toBeNull();
    expect(minimapMatch![1]).toMatch(/touch-action:\s*none;/);

    const trackMatch = cssContent.match(/\.scrollmap-track-container\s*\{([^}]*)\}/);
    expect(trackMatch).not.toBeNull();
    expect(trackMatch![1]).toMatch(/touch-action:\s*none;/);
  });
});
