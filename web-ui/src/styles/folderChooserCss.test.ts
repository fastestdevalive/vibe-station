import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "workspace.css"), "utf8");

// jsdom has no layout, so assert the declaration that keeps phone targets at 44px.
describe("folder chooser phone targets", () => {
  it("gives rows, Up, close and footer buttons the touch height", () => {
    const start = css.indexOf(
      ".folder-chooser__item,\n  .folder-chooser__path-input,\n  .folder-chooser__nav .btn,",
    );
    expect(start).toBeGreaterThan(0);
    const rule = css.slice(start, css.indexOf("}", start));
    expect(rule).toMatch(/\.dialog-card--folder-chooser \.dialog-card__header \.icon-btn/);
    expect(rule).toMatch(/\.dialog-card--folder-chooser \.dialog-actions \.btn/);
    expect(rule).toMatch(/min-height:\s*var\(--h-touch\)/);
    const media = css.lastIndexOf("@media (max-width: 640px)", start);
    expect(start - media).toBeLessThan(80);
  });

  it("keeps the close button 44px wide and the list short enough on phones", () => {
    const media = css.indexOf("@media (max-width: 640px) {\n  .folder-chooser__item,");
    expect(media).toBeGreaterThan(0);
    const end = css.indexOf("\n}\n", media);
    const phone = css.slice(media, end);
    expect(phone).toMatch(/\.icon-btn \{\s*min-width:\s*var\(--h-touch\)/);
    expect(phone).toMatch(/\.folder-chooser__list-container \{\s*min-height:\s*120px/);
  });
});
