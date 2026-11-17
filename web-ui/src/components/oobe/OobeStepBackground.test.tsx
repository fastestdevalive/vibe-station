import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperEntry } from "@/api/types";
import { __resetBackgroundStoreForTests, getBackgroundStore } from "@/components/background/backgroundStore";
import { __resetWallpaperImageForTests } from "@/components/background/useWallpaperImage";
import { OobeStepBackground } from "./OobeStepBackground";

const { fetchBlobMock } = vi.hoisted(() => ({ fetchBlobMock: vi.fn<() => Promise<Blob>>() }));
vi.mock("@/components/background/wallpaperApi", () => ({ fetchWallpaperBlob: fetchBlobMock }));

const { catalogRef } = vi.hoisted(() => ({
  catalogRef: {
    state: {
      status: "ready" as "loading" | "ready" | "unavailable",
      wallpapers: [] as WallpaperEntry[],
      ids: [] as string[],
    },
  },
}));

vi.mock("@/components/background/useWallpaperCatalog", () => ({
  useWallpaperCatalog: () => catalogRef.state,
}));

function entries(ids: string[]): WallpaperEntry[] {
  return ids.map((id) => ({
    id,
    name: id,
    category: "places",
    mode: "any",
    url: `https://images.rawpixel.com/${id}.jpg`,
    thumbnailUrl: `https://images.rawpixel.com/${id}.jpg`,
    width: 683,
    height: 1024,
    license: "CC0",
  }));
}

beforeEach(() => {
  __resetBackgroundStoreForTests();
  __resetWallpaperImageForTests();
  fetchBlobMock.mockReset();
  // Never resolves: the bundled thumb is what these assertions look at.
  fetchBlobMock.mockImplementation(() => new Promise<Blob>(() => {}));
  catalogRef.state = { status: "ready", wallpapers: entries(["wp-001", "wp-002"]), ids: ["wp-001", "wp-002"] };
});

afterEach(() => {
  __resetBackgroundStoreForTests();
  __resetWallpaperImageForTests();
});

describe("OobeStepBackground", () => {
  it("opens wallpaper section", () => {
    render(<OobeStepBackground onNext={vi.fn()} />);

    expect(screen.getByText("Choose a background")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Wallpaper/, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Texture/, expanded: false })).toBeInTheDocument();
  });

  it("skip keeps the rolled pick", () => {
    const store = getBackgroundStore();
    store.ensureRolled(["wp-001", "wp-002"], () => 0);
    const before = store.getState();
    const onNext = vi.fn();

    render(<OobeStepBackground onNext={onNext} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(store.getState().wallpaperId).toBe(before.wallpaperId);
    expect(store.getState().rolled).toBe(true);
  });

  it("continue calls onNext", () => {
    const onNext = vi.fn();
    render(<OobeStepBackground onNext={onNext} />);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("shows later-in-settings caption", () => {
    render(<OobeStepBackground onNext={vi.fn()} />);

    expect(screen.getByText(/You can change this later in Settings\./)).toBeInTheDocument();
  });

  it("the preview is the mini window here too", () => {
    const { container } = render(<OobeStepBackground onNext={vi.fn()} />);

    expect(container.querySelector(".wp-preview .wp-mini")).not.toBeNull();
  });
});
