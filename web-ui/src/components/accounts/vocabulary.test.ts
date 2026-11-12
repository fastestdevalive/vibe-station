import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
const DIRS = ["components/accounts", "components/limits", "components/chat", "components/draft", "components/layout", "lib"];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

const files = DIRS.flatMap((d) => sources(join(SRC, d)));
// Patterns are built from fragments so this file never matches its own words.
const OLD = [new RegExp("needs sign-?" + "in", "i"), new RegExp("Sign in " + "again"), new RegExp("status " + "unknown", "i")];

describe("account vocabulary guard", () => {
  it("scans a non-trivial set of files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("uses no retired account wording", () => {
    const hits = files.flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return OLD.filter((re) => re.test(text)).map((re) => `${f}: ${re}`);
    });
    expect(hits).toEqual([]);
  });

  it("has no warning glyph in account components", () => {
    const hits = files.filter((f) => f.includes("components/accounts") && readFileSync(f, "utf8").includes("⚠"));
    expect(hits).toEqual([]);
  });
});
