import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperEntry } from "@/api/types";
import {
  __resetBackgroundStoreForTests,
  getBackgroundStore,
  type ScopeKey,
} from "./backgroundStore";
import { resolveWallpaper } from "./resolveWallpaper";
import { thumbUrl } from "./thumbs";
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
const SCOPE_KEY: ScopeKey = "worktree:w1";
const SCOPE = {
  key: SCOPE_KEY,
  label: "wallpaper-effects",
};
const PROJECT_KEY: ScopeKey = "project:p1";
const PROJECT = {
  key: PROJECT_KEY,
  label: "file-search",
};

/** The Default tile's thumb id must be what the scope actually resolves to. */
function resolvedScopeId(key: ScopeKey): string | null {
  const prefs = getBackgroundStore().getState();
  const resolved = resolveWallpaper(
    { t: "scope", scope: key },
    {
      mode: prefs.mode,
      appWallpaperId: prefs.wallpaperId,
      agentWallpapers: prefs.agentWallpapers,
      reduceTransparency: false,
      catalogIds: IDS,
      seed: prefs.seeds[key],
      override: prefs.overrides[key],
    },
  );
  return resolved.t === "image" ? resolved.id : null;
}

function defaultTileThumb(container: HTMLElement): string | null {
  return container.querySelector(".wp-card__thumb")?.getAttribute("src") ?? null;
}

function defaultTile(container: HTMLElement): HTMLElement {
  const button = container.querySelectorAll("button")[0];
  if (button === undefined) throw new Error("no Default tile");
  return button;
}

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

beforeEach(() => {
  __resetBackgroundStoreForTests();
  __resetWallpaperImageForTests();
  fetchBlobMock.mockReset();
  fetchBlobMock.mockImplementation(() => new Promise<Blob>(() => {}));
  catalogRef.state = { status: "ready", wallpapers: entries(IDS), ids: IDS };
});

afterEach(() => {
  __resetBackgroundStoreForTests();
  __resetWallpaperImageForTests();
});

describe("Picker (scope mode)", () => {
  it("default and none tiles first", () => {
    const { container } = render(<Picker mode="scope" scope={SCOPE} />);

    expect(screen.getByText("Wallpaper · wallpaper-effects")).toBeInTheDocument();
    expect(screen.getByText("Only this worktree")).toBeInTheDocument();

    const buttons = container.querySelectorAll("button");
    expect(buttons[0]?.textContent).toContain("Default");
    expect(buttons[0]?.textContent).toContain("picked for this worktree");
    expect(buttons[1]?.textContent).toContain("None");
    expect(buttons[2]?.getAttribute("aria-label")).toBe("Fog Mountain");
  });

  it("B off: Default follows the app background", () => {
    getBackgroundStore().patch({ agentWallpapers: false, wallpaperId: "wp-002" });
    const { container } = render(<Picker mode="scope" scope={SCOPE} />);

    expect(defaultTile(container)).toHaveTextContent("Stars Dark · follows app background");
    expect(resolvedScopeId(SCOPE_KEY)).toBe("wp-002");
    expect(defaultTileThumb(container)).toBe(thumbUrl("wp-002"));
  });

  it("B on + worktree seed: the wallpaper was given when the agent was created", () => {
    getBackgroundStore().writeSeedIfAbsent(SCOPE_KEY, "wp-003");
    const { container } = render(<Picker mode="scope" scope={SCOPE} />);

    expect(defaultTile(container)).toHaveTextContent(
      "Clouds Dusk · given when this agent was created",
    );
    expect(resolvedScopeId(SCOPE_KEY)).toBe("wp-003");
    expect(defaultTileThumb(container)).toBe(thumbUrl("wp-003"));
  });

  it("B on + worktree without a seed: Default is a pick for this worktree, not the app background", () => {
    const { container } = render(<Picker mode="scope" scope={SCOPE} />);

    const id = resolvedScopeId(SCOPE_KEY);
    expect(id).not.toBeNull();
    expect(defaultTileThumb(container)).toBe(thumbUrl(id as string));
    expect(defaultTile(container)).toHaveTextContent(
      `${NAMES[id as string]} · picked for this worktree`,
    );
  });

  it("B on + project: Default is a pick for this project", () => {
    const { container } = render(<Picker mode="scope" scope={PROJECT} />);

    const id = resolvedScopeId(PROJECT_KEY);
    expect(id).not.toBeNull();
    expect(defaultTileThumb(container)).toBe(thumbUrl(id as string));
    expect(defaultTile(container)).toHaveTextContent(
      `${NAMES[id as string]} · picked for this project`,
    );
  });

  it("B on + project with a seed: still a pick for this project (no agent created it)", () => {
    getBackgroundStore().writeSeedIfAbsent(PROJECT_KEY, "wp-002");
    const { container } = render(<Picker mode="scope" scope={PROJECT} />);

    expect(defaultTile(container)).toHaveTextContent("Stars Dark · picked for this project");
    expect(resolvedScopeId(PROJECT_KEY)).toBe("wp-002");
    expect(defaultTileThumb(container)).toBe(thumbUrl("wp-002"));
  });

  it("catalog unknown: the Default tile has no wallpaper name to add", () => {
    catalogRef.state = { status: "loading", wallpapers: [], ids: [] };
    const { container } = render(<Picker mode="scope" scope={SCOPE} />);

    expect(defaultTile(container)).toHaveTextContent("picked for this worktree");
    expect(defaultTile(container).textContent).not.toContain("·");
  });

  it("none sets override none", () => {
    render(<Picker mode="scope" scope={SCOPE} />);

    fireEvent.click(screen.getByRole("button", { name: /^None/ }));

    expect(getBackgroundStore().getState().overrides[SCOPE_KEY]).toEqual({ kind: "none" });
  });

  it("default clears override", () => {
    const store = getBackgroundStore();
    store.setOverride(SCOPE_KEY, { kind: "id", id: "wp-002" });
    render(<Picker mode="scope" scope={SCOPE} />);

    fireEvent.click(screen.getByRole("button", { name: /^Default/ }));

    expect(store.getState().overrides[SCOPE_KEY]).toBeUndefined();
  });

  it("picking a thumb sets that id as the override", () => {
    const store = getBackgroundStore();
    render(<Picker mode="scope" scope={SCOPE} />);

    fireEvent.click(screen.getByRole("button", { name: "Stars Dark" }));

    expect(store.getState().overrides[SCOPE_KEY]).toEqual({ kind: "id", id: "wp-002" });
  });

  it("no texture section", () => {
    render(<Picker mode="scope" scope={SCOPE} />);

    expect(screen.queryByText("Texture")).toBeNull();
    expect(screen.queryByRole("slider", { name: "Texture intensity" })).toBeNull();
  });
});
