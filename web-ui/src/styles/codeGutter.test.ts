import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/workspace.css"), "utf8");
const block = (selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
};

describe("code viewer line-number gutter", () => {
  it("is sticky-left so numbers never scroll horizontally with long lines", () => {
    const g = block(".workspace-code-gutter");
    expect(g).toMatch(/position:\s*sticky/);
    expect(g).toMatch(/left:\s*0/);
    expect(g).toMatch(/background:/); // opaque, so code slides underneath
  });

  it("lines span their full scroll width (sticky needs that containing block)", () => {
    const l = block(".workspace-code-line");
    expect(l).toMatch(/width:\s*max-content/);
    expect(l).toMatch(/min-width:\s*100%/);
  });

  it("git change marks sit on the RIGHT of the numbers", () => {
    expect(block(".workspace-code-line--added .workspace-code-gutter")).toMatch(/inset -2px/);
    expect(block(".workspace-code-line--modified .workspace-code-gutter")).toMatch(/inset -2px/);
    expect(block(".workspace-code-line--deleted .workspace-code-gutter::after")).toMatch(/right:\s*0/);
    expect(block(".workspace-code-line--deleted-top .workspace-code-gutter::before")).toMatch(/right:\s*0/);
  });
});

describe("chat diff", () => {
  it("hides the old-line-number column and keeps only the new one, flush left", () => {
    expect(block(".chat-tool-entry__body .diff-line > .diff-gutter:first-child")).toMatch(/display:\s*none/);
    expect(block(".chat-tool-entry__body .diff-line")).toMatch(/grid-template-columns:\s*32px 10px 1fr/);
    expect(block(".chat-tool-entry__body .diff-gutter")).toMatch(/text-align:\s*left/);
  });
});
