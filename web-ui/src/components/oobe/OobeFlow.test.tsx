import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperEntry } from "@/api/types";
import { createMockApi } from "@/api/mock";
import { __resetBackgroundStoreForTests } from "@/components/background/backgroundStore";
import { __resetWallpaperCatalogForTests } from "@/components/background/useWallpaperCatalog";
import { __resetWallpaperImageForTests } from "@/components/background/useWallpaperImage";
import { OobeFlow } from "./OobeFlow";

const { fetchCatalogMock, fetchBlobMock } = vi.hoisted(() => ({
  fetchCatalogMock: vi.fn<() => Promise<{ version: number; wallpapers: WallpaperEntry[] }>>(),
  fetchBlobMock: vi.fn<() => Promise<Blob>>(),
}));

vi.mock("@/components/background/wallpaperApi", () => ({
  fetchWallpaperCatalog: fetchCatalogMock,
  fetchWallpaperBlob: fetchBlobMock,
}));

function entry(id: string): WallpaperEntry {
  return {
    id,
    name: id,
    category: "places",
    mode: "any",
    url: `https://images.rawpixel.com/${id}.jpg`,
    thumbnailUrl: `https://images.rawpixel.com/${id}.jpg`,
    width: 683,
    height: 1024,
    license: "CC0",
  };
}

beforeEach(() => {
  __resetBackgroundStoreForTests();
  __resetWallpaperCatalogForTests();
  __resetWallpaperImageForTests();
  fetchCatalogMock.mockReset();
  fetchCatalogMock.mockResolvedValue({ version: 1, wallpapers: [entry("wp-001"), entry("wp-002")] });
  fetchBlobMock.mockReset();
  fetchBlobMock.mockImplementation(() => new Promise<Blob>(() => {}));
});

function renderFlow(currentStep: 1 | 2 | 3) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <OobeFlow
        api={createMockApi() as never}
        currentStep={currentStep}
        defaultProjectsDir="/mock/projects"
        vstHome="/mock/home/.vibe-station"
        onStep1Confirmed={() => {}}
        onStep2Confirmed={() => {}}
        onCompleted={() => {}}
      />
    </MemoryRouter>,
  );
}

describe("OobeFlow background step", () => {
  it("shows Step 3 of 4 for background", () => {
    renderFlow(3);

    expect(screen.getByText("Step 3 of 4")).toBeInTheDocument();
    expect(screen.getByText("Choose a background")).toBeInTheDocument();
  });

  it("doctor is step 4 of 4", async () => {
    renderFlow(3);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(screen.getByText("Step 4 of 4")).toBeInTheDocument());
  });

  it("back from step 3 returns to modes", async () => {
    renderFlow(3);

    fireEvent.click(screen.getByRole("button", { name: /← Back/ }));

    expect(screen.getByText("Step 2 of 4")).toBeInTheDocument();
    expect(await screen.findByTestId("oobe-step2")).toBeInTheDocument();
  });

  it("currentStep 3 resumes at background", () => {
    renderFlow(3);

    expect(screen.getByTestId("oobe-step-background")).toBeInTheDocument();
    expect(screen.queryByTestId("oobe-step2")).toBeNull();
  });
});
