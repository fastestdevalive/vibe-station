import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "selection.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("selection.css", () => {
  it("denies selection on body with the -webkit- prefix", () => {
    expect(css).toMatch(/body\s*\{[^}]*-webkit-user-select:\s*none/);
  });

  it("re-enables prefixed selection for the allowlist, including error text", () => {
    const m = /([^{}]*\.selectable[^{}]*)\{([^}]*)\}/.exec(css);
    expect(m).not.toBeNull();
    const [, selectors, decls] = m!;
    for (const sel of [".selectable", ".chat-message-list", ".field-error", ".error-text", '[role="alert"]']) {
      expect(selectors).toContain(sel);
    }
    expect(decls).toContain("-webkit-user-select: text");
  });

  it("never touches .xterm (xterm owns its selection)", () => {
    expect(css).not.toContain(".xterm");
  });
});
