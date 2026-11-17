import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WallpaperEntry } from "@/api/types";
import { loadCascade } from "@/test/cssCascade";
import { thumbUrl } from "./thumbs";
import { WallpaperGrid } from "./WallpaperGrid";

const pickerCss = readFileSync(resolve(__dirname, "picker.css"), "utf8");

const ENTRY: WallpaperEntry = {
  id: "wp-001",
  name: "Railroads in fog",
  category: "abstract",
  mode: "any",
  url: "https://images.rawpixel.com/a.jpg",
  thumbnailUrl: "https://images.rawpixel.com/a.jpg",
  width: 683,
  height: 1024,
};

describe("WallpaperGrid", () => {
  it("thumb has 16:9 and focal object-position", () => {
    const onPick = vi.fn();
    const { container } = render(
      <WallpaperGrid wallpapers={[ENTRY]} selectedId="wp-001" onPick={onPick} />,
    );

    const thumb = container.querySelector(".wp-thumb") as HTMLButtonElement;
    expect(thumb).not.toBeNull();
    expect(thumb.getAttribute("aria-pressed")).toBe("true");
    expect(thumb.getAttribute("aria-label")).toBe("Railroads in fog");

    const img = thumb.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(thumbUrl("wp-001"));
    // wp-001's focal point in focal.ts (design focal169_pos.json).
    expect(img.style.objectPosition).toBe("50% 58%");

    // The 16:9 crop is the design's 384x216 thumb ratio (CSS, tokens only).
    expect(pickerCss).toMatch(/\.wp-thumb\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/);

    fireEvent.click(thumb);
    expect(onPick).toHaveBeenCalledWith("wp-001");
  });

  it("prepends the Default and None tiles in scope mode", () => {
    const { container } = render(
      <WallpaperGrid
        wallpapers={[ENTRY]}
        selectedId={null}
        onPick={() => {}}
        defaultTile={{
          wallpaperId: "wp-001",
          caption: "given when this agent was created",
          selected: true,
          onPick: () => {},
        }}
        noneTile={{ caption: "Solid on this screen only", selected: false, onPick: () => {} }}
      />,
    );

    const buttons = container.querySelectorAll("button");
    expect(buttons[0]?.textContent).toContain("Default");
    expect(buttons[1]?.textContent).toContain("None");
    expect(buttons[2]?.getAttribute("aria-label")).toBe("Railroads in fog");
  });

  it("the Default tile's caption truncates instead of overflowing the card", () => {
    // The caption now names the wallpaper ("Railroads in fog · given when …"), so a
    // phone card must ellipsise it on one line rather than push past the thumb.
    const cap = loadCascade(pickerCss).decls(".wp-card__cap");
    expect(cap["min-width"]).toBe("0");
    expect(cap.overflow).toBe("hidden");
    expect(cap["text-overflow"]).toBe("ellipsis");
    expect(cap["white-space"]).toBe("nowrap");
  });
});
