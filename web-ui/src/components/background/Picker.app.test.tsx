import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperEntry } from "@/api/types";
import { __resetBackgroundStoreForTests, getBackgroundStore } from "./backgroundStore";
import { GRADIENTS } from "./gradient";
import { __resetWallpaperImageForTests } from "./useWallpaperImage";
import { Picker } from "./Picker";

const { fetchBlobMock } = vi.hoisted(() => ({ fetchBlobMock: vi.fn<() => Promise<Blob>>() }));

vi.mock("./wallpaperApi", () => ({ fetchWallpaperBlob: fetchBlobMock }));

const { catalogRef } = vi.hoisted(() => ({
  catalogRef: {
    state: {
      status: "loading" as "loading" | "ready" | "unavailable",
      wallpapers: [] as WallpaperEntry[],
      ids: [] as string[],
    },
  },
}));

vi.mock("./useWallpaperCatalog", () => ({
  useWallpaperCatalog: () => catalogRef.state,
}));

const IDS = ["wp-001", "wp-002", "wp-003"];
const NAMES: Record<string, string> = {
  "wp-001": "Fog Mountain",
  "wp-002": "Stars Dark",
  "wp-003": "Clouds Dusk",
};

function entries(ids: string[]): WallpaperEntry[] {
  return ids.map((id) => ({
    id,
    name: NAMES[id] ?? id,
    category: "places",
    mode: "any",
    url: `https://images.rawpixel.com/${id}.jpg`,
    thumbnailUrl: `https://images.rawpixel.com/${id}.jpg`,
    width: 683,
    height: 1024,
    license: "CC0",
  }));
}

function setCatalog(ids: string[], status: "ready" | "unavailable" = "ready"): void {
  catalogRef.state = { status, wallpapers: entries(ids), ids };
}

beforeEach(() => {
  __resetBackgroundStoreForTests();
  __resetWallpaperImageForTests();
  fetchBlobMock.mockReset();
  // Never resolves: the bundled thumb is what these assertions look at.
  fetchBlobMock.mockImplementation(() => new Promise<Blob>(() => {}));
  setCatalog(IDS);
});

afterEach(() => {
  __resetBackgroundStoreForTests();
  __resetWallpaperImageForTests();
});

describe("Picker (app mode)", () => {
  it("closed sections by default in settings", () => {
    render(<Picker mode="app" />);

    expect(screen.getByRole("button", { name: /^Wallpaper/, expanded: false })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Texture/, expanded: false })).toBeInTheDocument();
    // The grid exists but is closed: nothing inside it is reachable yet.
    expect(screen.queryByRole("button", { name: "Stars Dark" })).toBeNull();
  });

  it("initialOpen opens wallpaper only", () => {
    render(<Picker mode="app" initialOpen={{ wallpaper: true, texture: false }} />);

    expect(screen.getByRole("button", { name: /^Wallpaper/, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Texture/, expanded: false })).toBeInTheDocument();
    // Onboarding's own disclosure state is never written to the device's.
    expect(getBackgroundStore().getState().sections).toEqual({
      wallpaper: false,
      texture: false,
      visibility: false,
      gradient: false,
    });
  });

  it("remembers section state per device", () => {
    const { unmount } = render(<Picker mode="app" />);

    fireEvent.click(screen.getByRole("button", { name: /^Texture/, expanded: false }));

    expect(getBackgroundStore().getState().sections.texture).toBe(true);
    expect(screen.getByRole("button", { name: /^Texture/, expanded: true })).toBeInTheDocument();

    unmount();
    render(<Picker mode="app" />);
    expect(screen.getByRole("button", { name: /^Texture/, expanded: true })).toBeInTheDocument();
  });

  it("selecting a thumb patches the store", () => {
    const store = getBackgroundStore();
    render(<Picker mode="app" />);

    fireEvent.click(screen.getByRole("button", { name: /^Wallpaper/, expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: "Stars Dark" }));

    expect(store.getState().wallpaperId).toBe("wp-002");
    expect(store.getState().mode).toBe("wallpaper");
  });

  it("shuffle picks a different id", () => {
    const store = getBackgroundStore();
    store.patch({ wallpaperId: "wp-001", mode: "wallpaper" });
    render(<Picker mode="app" />);

    fireEvent.click(screen.getByRole("button", { name: "Shuffle wallpaper" }));

    expect(store.getState().wallpaperId).not.toBe("wp-001");
    expect(IDS).toContain(store.getState().wallpaperId);
  });

  it("the system-pick chip follows the pick, not forever", () => {
    const store = getBackgroundStore();
    store.ensureRolled(IDS, () => 0);

    const { unmount } = render(<Picker mode="app" />);
    expect(screen.getByText("Picked for you")).toBeInTheDocument();
    unmount();

    // A manual wallpaper pick clears the chip…
    render(<Picker mode="app" initialOpen={{ wallpaper: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Stars Dark" }));
    expect(store.getState().picked).toBe(false);
    expect(screen.queryByText("Picked for you")).toBeNull();

    // …and Shuffle makes it a system pick again.
    fireEvent.click(screen.getByRole("button", { name: "Shuffle wallpaper" }));
    expect(store.getState().picked).toBe(true);
    expect(screen.getByText("Picked for you")).toBeInTheDocument();
  });

  it("a manual texture pick clears the chip too", () => {
    const store = getBackgroundStore();
    store.ensureRolled(IDS, () => 0);
    render(<Picker mode="app" initialOpen={{ texture: true }} />);

    fireEvent.click(screen.getByRole("button", { name: "Grain" }));

    expect(store.getState().texture).toBe("grain");
    expect(store.getState().picked).toBe(false);
    expect(screen.queryByText("Picked for you")).toBeNull();
  });

  it("the texture suffix carries its own class in the selection row", () => {
    const store = getBackgroundStore();
    store.patch({ wallpaperId: "wp-001", mode: "wallpaper", texture: "grain" });
    const { container } = render(<Picker mode="app" />);

    // The suffix is the secondary detail: its own class lets CSS make it yield
    // before the wallpaper name does at phone width.
    const row = container.querySelector(".wp-sel__text");
    expect(row?.querySelector(".wp-sel__name")?.textContent).toBe("Fog Mountain");
    expect(row?.querySelector(".wp-sel__rest")?.textContent).toBe("· Grain");
  });

  it("Settings passes the first-run chip label", () => {
    getBackgroundStore().ensureRolled(IDS, () => 0);
    render(<Picker mode="app" pickLabel="Picked at first run" />);

    expect(screen.getByText("Picked at first run")).toBeInTheDocument();
    expect(screen.queryByText("Picked for you")).toBeNull();
  });

  it("solid disables texture", () => {
    getBackgroundStore().patch({ mode: "solid" });
    render(<Picker mode="app" />);

    expect(screen.queryByRole("button", { name: /^Texture/ })).toBeNull();
    expect(screen.getByText(/No wallpaper anywhere/)).toBeInTheDocument();
  });

  it("catalog unavailable disables wallpaper", () => {
    setCatalog(IDS, "unavailable");
    render(<Picker mode="app" />);

    expect(screen.getByRole("radio", { name: "Wallpaper" })).toBeDisabled();
    expect(screen.getByText("Wallpapers unavailable")).toBeInTheDocument();
  });

  it("the preview is the mini window in Settings and onboarding", () => {
    const settings = render(<Picker mode="app" />);
    expect(settings.container.querySelector(".wp-preview .wp-mini")).not.toBeNull();
    settings.unmount();

    const onboarding = render(<Picker mode="app" initialOpen={{ wallpaper: true, texture: false }} />);
    expect(onboarding.container.querySelector(".wp-preview .wp-mini")).not.toBeNull();
  });

  it("the Gradient section is closed in Settings and onboarding", () => {
    render(<Picker mode="app" />);
    expect(screen.getByRole("button", { name: /^Gradient/, expanded: false })).toBeInTheDocument();

    // Onboarding's own disclosure state never touches the device's.
    render(<Picker mode="app" initialOpen={{ wallpaper: true, texture: false }} />);
    expect(screen.getAllByRole("button", { name: /^Gradient/, expanded: false }).length).toBeGreaterThan(0);
    expect(getBackgroundStore().getState().sections.gradient).toBe(false);
  });

  it("the Gradient tiles list every preset in table order and pick by id", () => {
    const store = getBackgroundStore();
    const { container } = render(<Picker mode="app" />);

    const header = screen.getByRole("button", { name: /^Gradient/, expanded: false });
    fireEvent.click(header);
    expect(store.getState().sections.gradient).toBe(true);
    expect(screen.getByRole("button", { name: /^Gradient/, expanded: true })).toBeInTheDocument();

    const tiles = [...container.querySelectorAll<HTMLButtonElement>("#wp-gradient .wp-tile")];
    expect(tiles.map((t) => t.querySelector(".wp-tile__label")?.textContent)).toEqual(
      GRADIENTS.map((g) => g.label),
    );
    // First run: "Soft fade" is the selected preset (the default), not the first tile.
    const pressed = tiles.filter((t) => t.getAttribute("aria-pressed") === "true");
    expect(pressed.map((t) => t.querySelector(".wp-tile__label")?.textContent)).toEqual(["Soft fade"]);

    fireEvent.click(screen.getByRole("button", { name: "Top fade" }));
    expect(store.getState().gradient).toBe("top_fade");
    expect(screen.getByRole("button", { name: "Top fade" }).getAttribute("aria-pressed")).toBe("true");
    // The closed row summarises the chosen preset.
    expect(screen.getByRole("button", { name: /^Gradient/, expanded: true }).textContent).toContain("Top fade");
  });
});
