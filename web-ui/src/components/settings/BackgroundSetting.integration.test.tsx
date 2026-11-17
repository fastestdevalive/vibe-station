import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WallpaperCatalogResponse } from "@/api/types";
import { BackgroundSetting } from "./BackgroundSetting";
import { __resetBackgroundStoreForTests } from "@/components/background/backgroundStore";
import { __resetWallpaperCatalogForTests } from "@/components/background/useWallpaperCatalog";
import { __resetWallpaperImageForTests } from "@/components/background/useWallpaperImage";

/**
 * The join between Track A's Picker/CollapsibleSection and Track B's settings
 * body: nothing here is mocked except the daemon calls, so a contract drift
 * (e.g. a section that forgets `aria-expanded`) fails here.
 */
const CATALOG: WallpaperCatalogResponse = {
  version: 1,
  wallpapers: [
    {
      id: "wp-001",
      name: "Railroads in fog",
      category: "abstract",
      mode: "any",
      url: "https://images.rawpixel.com/wp-001.jpg",
      thumbnailUrl: "https://images.rawpixel.com/wp-001.jpg",
      width: 680,
      height: 1024,
    },
    {
      id: "wp-010",
      name: "Fog Mountain",
      category: "abstract",
      mode: "any",
      url: "https://cdn.stocksnap.io/wp-010.jpg",
      thumbnailUrl: "https://cdn.stocksnap.io/wp-010.jpg",
      width: 680,
      height: 1024,
    },
    {
      id: "wp-030",
      name: "Stars Dark",
      category: "abstract",
      mode: "dark",
      url: "https://cdn.stocksnap.io/wp-030.jpg",
      thumbnailUrl: "https://cdn.stocksnap.io/wp-030.jpg",
      width: 680,
      height: 1024,
    },
  ],
};

vi.mock("@/components/background/wallpaperApi", () => ({
  fetchWallpaperCatalog: async (): Promise<WallpaperCatalogResponse> => CATALOG,
  wallpaperImageUrl: (id: string, size: string): string =>
    `/api/wallpapers/${encodeURIComponent(id)}/image?size=${size}`,
  fetchWallpaperBlob: async (): Promise<Blob> => new Blob([new Uint8Array([1])], { type: "image/jpeg" }),
}));

beforeEach(() => {
  localStorage.clear();
  __resetBackgroundStoreForTests();
  __resetWallpaperCatalogForTests();
  __resetWallpaperImageForTests();
});

function disclosures(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"));
}

function disclosure(title: string): HTMLButtonElement | undefined {
  return disclosures().find((b) => (b.textContent ?? "").trim().startsWith(title));
}

describe("BackgroundSetting with the real Picker", () => {
  it("settings background shows closed Wallpaper and Texture sections", async () => {
    render(<BackgroundSetting />);

    await waitFor(() => {
      expect(disclosure("Wallpaper")).toBeTruthy();
      expect(disclosure("Texture")).toBeTruthy();
    });

    expect(disclosure("Wallpaper")!.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure("Texture")!.getAttribute("aria-expanded")).toBe("false");

    // Visibility is Track B's own disclosure, closed from the same store.
    expect(disclosure("Visibility")!.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("slider")).toHaveLength(0);

    // The device-level switch and its pointer survive next to the picker.
    expect(screen.getByRole("switch", { name: "Own wallpaper per agent" })).toBeInTheDocument();
    expect(
      screen.getByText("For one worktree or project, open its options menu and choose Wallpaper."),
    ).toBeInTheDocument();

    // R1F-08: the header sentence differs from the picker's mode caption, so the
    // same sentence no longer appears twice.
    expect(
      screen.getByText("Solid, or one wallpaper behind the whole window with a texture over it."),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/One wallpaper behind the whole window/)).toHaveLength(1);
  });
});
