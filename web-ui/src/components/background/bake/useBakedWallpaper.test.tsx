import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { textureById } from "../textureCatalog";
import { useBakedWallpaper, type UseBakedWallpaperArgs } from "./useBakedWallpaper";

const { getBakedUrlMock, peekMock, pinMock, rememberMock, bakeMock } = vi.hoisted(() => ({
  getBakedUrlMock: vi.fn<(key: string) => Promise<string | null>>(),
  peekMock: vi.fn<(key: string) => string | null>(),
  pinMock: vi.fn<(key: string) => () => void>(),
  rememberMock: vi.fn<(key: string, blob: Blob) => string>(),
  bakeMock: vi.fn<(input: unknown) => Promise<Blob>>(),
}));

vi.mock("./bakeCache", () => ({
  getBakedUrl: getBakedUrlMock,
  peekBakedUrl: peekMock,
  pinBaked: pinMock,
  rememberBaked: rememberMock,
}));

vi.mock("./bakeClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bakeClient")>();
  // Only the worker round-trip is faked; size normalisation is the real one.
  return { bake: bakeMock, bakeSize: actual.bakeSize };
});

const ARGS: UseBakedWallpaperArgs = {
  id: "wp-007",
  sha: null,
  texture: textureById("dither"),
  appearance: "dark",
  size: { width: 1280, height: 832 },
};

function Harness(props: UseBakedWallpaperArgs) {
  const state = useBakedWallpaper(props);
  return <div data-testid="state">{`${state.status}|${state.url ?? ""}`}</div>;
}

function state(container: HTMLElement): string {
  return container.querySelector("[data-testid='state']")?.textContent ?? "";
}

let remembered = 0;

beforeEach(() => {
  getBakedUrlMock.mockReset();
  bakeMock.mockReset();
  peekMock.mockReset();
  pinMock.mockReset();
  rememberMock.mockReset();
  remembered = 0;
  peekMock.mockReturnValue(null);
  pinMock.mockReturnValue(() => {});
  rememberMock.mockImplementation(() => `blob:remembered-${remembered++}`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useBakedWallpaper", () => {
  it("cache hit goes straight to ready", async () => {
    getBakedUrlMock.mockResolvedValue("blob:cached");

    const { container } = render(<Harness {...ARGS} />);

    await waitFor(() => expect(state(container)).toBe("ready|blob:cached"));
    // The cache key uses the size the bake client will use.
    expect(getBakedUrlMock).toHaveBeenCalledWith(expect.stringMatching(/\|1280x832\|\d+$/));
    expect(bakeMock).not.toHaveBeenCalled();
  });

  it("cache miss bakes, remembers the blob and shows it", async () => {
    getBakedUrlMock.mockResolvedValue(null);
    bakeMock.mockResolvedValue(new Blob(["baked"]));

    const { container } = render(<Harness {...ARGS} />);

    await waitFor(() => expect(state(container)).toBe("ready|blob:remembered-0"));
    expect(bakeMock).toHaveBeenCalledTimes(1);
    expect(bakeMock).toHaveBeenCalledWith(expect.objectContaining({ width: 1280, height: 832 }));
    // The bake runs at full strength; intensity is the layer's opacity (R7F-02).
    expect(bakeMock.mock.calls[0]?.[0]).not.toHaveProperty("intensity");
    expect(rememberMock).toHaveBeenCalledWith(expect.stringMatching(/\|1280x832\|\d+$/), expect.any(Blob));
  });

  it("a memory hit is ready on the very first render", () => {
    peekMock.mockReturnValue("blob:memory");

    const { container } = render(<Harness {...ARGS} />);

    expect(state(container)).toBe("ready|blob:memory");
    expect(getBakedUrlMock).not.toHaveBeenCalled();
    expect(bakeMock).not.toHaveBeenCalled();
  });

  it("switching back to a remembered pair is ready on the first render (no flash, R6F-03)", async () => {
    const K = "blob:k";
    const L = "blob:l";
    getBakedUrlMock.mockImplementation(async (key) => (key.startsWith("wp-007|") ? K : L));

    const { container, rerender } = render(<Harness {...ARGS} />);
    await waitFor(() => expect(state(container)).toBe(`ready|${K}`));

    rerender(<Harness {...ARGS} id="wp-008" />);
    await waitFor(() => expect(state(container)).toBe(`ready|${L}`));

    // The memory tier now knows K: the first render after switching back is ready,
    // with no effect round-trip and no second cache/bake call for K.
    peekMock.mockImplementation((key) => (key.startsWith("wp-007|") ? K : null));
    rerender(<Harness {...ARGS} />);
    expect(state(container)).toBe(`ready|${K}`);

    const callsForK = getBakedUrlMock.mock.calls.filter(([key]) => key.startsWith("wp-007|"));
    expect(callsForK).toHaveLength(1);
    expect(bakeMock).not.toHaveBeenCalled();
  });

  it("pins the shown key while mounted and unpins on unmount", async () => {
    getBakedUrlMock.mockResolvedValue("blob:cached");
    const unpin = vi.fn();
    pinMock.mockReturnValue(unpin);

    const { container, unmount } = render(<Harness {...ARGS} />);
    await waitFor(() => expect(state(container)).toBe("ready|blob:cached"));
    expect(pinMock).toHaveBeenCalledWith(expect.stringMatching(/\|1280x832\|\d+$/));

    unmount();

    expect(unpin).toHaveBeenCalledTimes(1);
  });

  it("never revokes its URL: the memory tier owns it", async () => {
    getBakedUrlMock.mockResolvedValue("blob:cached");
    const revoke = vi.spyOn(URL, "revokeObjectURL");

    const { container, unmount } = render(<Harness {...ARGS} />);
    await waitFor(() => expect(state(container)).toBe("ready|blob:cached"));

    unmount();

    expect(revoke).not.toHaveBeenCalled();
  });

  it("failure reports failed with no url", async () => {
    getBakedUrlMock.mockResolvedValue(null);
    bakeMock.mockRejectedValue(new Error("worker died"));

    const { container } = render(<Harness {...ARGS} />);

    await waitFor(() => expect(state(container)).toBe("failed|"));
  });

  it("css texture stays idle and never bakes", async () => {
    const { container } = render(<Harness {...ARGS} texture={textureById("haze")} />);

    await waitFor(() => expect(state(container)).toBe("idle|"));
    expect(getBakedUrlMock).not.toHaveBeenCalled();
    expect(bakeMock).not.toHaveBeenCalled();
  });

  it("does not bake before the box is measured", async () => {
    const { container } = render(<Harness {...ARGS} size={{ width: 0, height: 0 }} />);

    await waitFor(() => expect(state(container)).toBe("baking|"));
    expect(getBakedUrlMock).not.toHaveBeenCalled();
  });
});
