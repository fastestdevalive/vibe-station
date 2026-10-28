import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCascade } from "@/test/cssCascade";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
const css = loadCascade([
  read("tokens.css"),
  read("workspace.css"),
  read("../components/comments/tray.css"),
  read("../components/comments/comments.css"),
  read("../components/artifacts/artifacts.css"),
]);

// L5-01: both are `position: fixed` portals to <body>; a fullscreen tools pane (`.pane-viewport-fullscreen`) must not cover them.
describe("portaled popover layer", () => {
  const fullscreen = css.px(".pane-viewport-fullscreen", "z-index");

  it("the send picker and the selection popover sit above a fullscreen pane via one token", () => {
    expect(fullscreen).toBe(200);
    for (const sel of [".comment-picker", ".comment-selpop"]) {
      expect(css.decls(sel)["z-index"], sel).toBe("var(--z-popover)");
      expect(css.px(sel, "z-index"), sel).toBeGreaterThan(fullscreen!);
    }
  });

  it("the artifacts menu uses the same token (no private z-index)", () => {
    expect(css.decls(".artifacts-menu:not(.artifacts-menu--sheet)")["z-index"]).toBe("var(--z-popover)");
  });
});
