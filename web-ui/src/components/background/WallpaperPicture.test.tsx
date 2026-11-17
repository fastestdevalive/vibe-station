import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PictureLayer } from "./WallpaperPicture";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");

function picture(container: HTMLElement): HTMLImageElement {
  const img = container.querySelector<HTMLImageElement>("img.wp-picture");
  if (img === null) throw new Error("no picture rendered");
  return img;
}

describe("PictureLayer", () => {
  it("draws a cover-sized picture at the wallpaper's focal point", () => {
    const { container } = render(<PictureLayer id="wp-003" src="blob:plain" />);

    const img = picture(container);
    expect(img.getAttribute("src")).toBe("blob:plain");
    expect(img.style.objectPosition).toBe("50% 82%");
    expect(img.getAttribute("draggable")).toBe("false");
  });

  it("an unknown id centres vertically, like the design's default crop", () => {
    const { container } = render(<PictureLayer id="wp-999" src="blob:plain" />);

    expect(picture(container).style.objectPosition).toBe("50% 50%");
  });

  it("a bundled thumb is drawn centred (it is already a 16:9 focal crop)", () => {
    const { container } = render(<PictureLayer id="wp-003" src="thumb.jpg" isThumb />);

    expect(picture(container).style.objectPosition).toBe("50% 50%");
  });

  it("keeps its class when a caller adds one", () => {
    const { container } = render(
      <PictureLayer id="wp-003" src="blob:plain" className="wp-picture--arriving" />,
    );

    const img = picture(container);
    expect(img.classList.contains("wp-picture--arriving")).toBe(true);
  });
});

describe("wallpaper picture sizing has one owner", () => {
  it("windowBackground.css defines the shared cover sizing once", () => {
    const css = read("windowBackground.css");

    expect(css).toMatch(/\.wp-picture\s*\{[^}]*object-fit:\s*cover/);
    expect(css).toMatch(/\.wp-picture\s*\{[^}]*width:\s*100%/);
    // The focal point is applied inline by `PictureLayer`, never in a stylesheet.
    expect(css).not.toMatch(/object-position:/);
    // The per-layer rules the shared class replaced are gone.
    expect(css).not.toContain(".window-bg__img");
    expect(css).not.toContain("wp-bg-fade");
  });

  it("no other stylesheet sizes or re-centres a wallpaper picture", () => {
    const effects = read("effects/effects.css");
    const picker = read("picker.css");

    expect(effects).not.toContain(".window-bg__baked");
    expect(effects).not.toMatch(/object-position:\s*50% 50%/);
    expect(picker).not.toContain(".wp-preview__img");
  });
});
