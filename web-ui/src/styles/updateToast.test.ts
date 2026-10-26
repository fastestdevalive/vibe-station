import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("undo toast placement", () => {
  it("sits above the global status bar", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/update.css"), "utf8");
    const block = /\.update-undo-toast \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/bottom:\s*calc\(var\(--global-status-bar-h,\s*24px\)\s*\+\s*var\(--space-2\)\)/);
  });
});
