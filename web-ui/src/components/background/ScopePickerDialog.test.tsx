import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperEntry } from "@/api/types";
import { __resetBackgroundStoreForTests, getBackgroundStore } from "./backgroundStore";
import { __resetWallpaperImageForTests } from "./useWallpaperImage";
import { useScopePickerStore } from "./scopePickerStore";
import { ScopePickerDialog } from "./ScopePickerDialog";

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
vi.mock("./useWallpaperCatalog", () => ({ useWallpaperCatalog: () => catalogRef.state }));

const { mobileRef } = vi.hoisted(() => ({ mobileRef: { value: false } }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mobileRef.value }));

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

function openPicker() {
  act(() =>
    useScopePickerStore.getState().show({
      scope: "worktree:w1",
      label: "wallpaper-effects",
      kind: "worktree",
    }),
  );
}

beforeEach(() => {
  __resetBackgroundStoreForTests();
  __resetWallpaperImageForTests();
  useScopePickerStore.setState({ open: null });
  fetchBlobMock.mockReset();
  fetchBlobMock.mockImplementation(() => new Promise<Blob>(() => {}));
  catalogRef.state = { status: "ready", wallpapers: entries(IDS), ids: IDS };
  mobileRef.value = false;
});

afterEach(() => {
  __resetBackgroundStoreForTests();
  __resetWallpaperImageForTests();
  useScopePickerStore.setState({ open: null });
});

describe("ScopePickerDialog", () => {
  it("opens from store and closes on Esc", () => {
    render(<ScopePickerDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();

    openPicker();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(useScopePickerStore.getState().open).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders scope picker with label", () => {
    render(<ScopePickerDialog />);
    openPicker();

    const dialog = screen.getByRole("dialog", { name: "Wallpaper · wallpaper-effects" });
    expect(within(dialog).getByText("Wallpaper · wallpaper-effects")).toBeInTheDocument();
    expect(within(dialog).getByText("Only this worktree")).toBeInTheDocument();
  });

  it("default caption says a seedless worktree pick is for this worktree", () => {
    render(<ScopePickerDialog />);
    openPicker();

    expect(screen.getByRole("button", { name: /^Default/ })).toHaveTextContent(
      "picked for this worktree",
    );
  });

  it("default caption says the seed was given when the agent was created", () => {
    getBackgroundStore().writeSeedIfAbsent("worktree:w1", "wp-002");
    render(<ScopePickerDialog />);
    openPicker();

    expect(screen.getByRole("button", { name: /^Default/ })).toHaveTextContent(
      "given when this agent was created",
    );
  });

  it("backdrop click closes", () => {
    render(<ScopePickerDialog />);
    openPicker();

    const overlay = document.querySelector(".wp-scope-overlay");
    expect(overlay).not.toBeNull();
    fireEvent.mouseDown(overlay!);

    expect(useScopePickerStore.getState().open).toBeNull();
  });

  it("phone uses BottomSheet", () => {
    mobileRef.value = true;
    render(<ScopePickerDialog />);
    openPicker();

    const dialog = screen.getByRole("dialog", { name: "Wallpaper · wallpaper-effects" });
    expect(dialog.className).toContain("bottom-sheet");
    expect(document.querySelector(".wp-scope-card")).toBeNull();

    fireEvent.click(screen.getByTestId("bottom-sheet-backdrop"));
    expect(useScopePickerStore.getState().open).toBeNull();
  });
});
