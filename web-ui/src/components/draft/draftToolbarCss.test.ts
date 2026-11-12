import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");

/** Body of the first `{...}` block that starts at `header` (brace-balanced). */
function block(css: string, header: string): string {
  const start = css.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced block: ${header}`);
}

// R4F-01: jsdom has no layout, so assert the declarations that keep Start inside the card.
describe("draft toolbar with the account chip", () => {
  it("wraps on a narrow composer and keeps Start at the right edge", () => {
    const narrow = block(read("DraftComposer.css"), "@container composer (max-width: 440px)");
    expect(block(narrow, ".draft-composer .chat-composer__toolbar {")).toMatch(/flex-wrap:\s*wrap/);
    expect(block(narrow, ".chat-composer__send {")).toMatch(/margin-left:\s*auto/);
  });

  it("lets the account chip shrink", () => {
    expect(block(read("../accounts/accounts.css"), ".account-picker {")).toMatch(/min-width:\s*0/);
  });
});
