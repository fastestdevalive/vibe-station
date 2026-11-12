import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createMockApi, type MockApi } from "@/api/mock";
import { useFileScrollMap, __resetFileScrollMapForTests } from "./useFileScrollMap";

let testApi: MockApi;

vi.mock("@/api", () => ({
  get api() {
    return testApi;
  },
  createMockApi,
}));

beforeEach(() => {
  __resetFileScrollMapForTests();
  testApi = createMockApi();
});

describe("useFileScrollMap", () => {
  it("defaults to 'minimap' before server resolves", () => {
    const { result } = renderHook(() => useFileScrollMap());
    expect(result.current[0]).toBe("minimap");
  });

  it("seeds from getSettings", async () => {
    testApi.__test.setSettings({ fileScrollMap: "marks" });
    const { result } = renderHook(() => useFileScrollMap());

    await waitFor(() => {
      expect(result.current[0]).toBe("marks");
    });
  });

  it("follows settings:updated WS event across mounted consumers", async () => {
    const { result: hook1 } = renderHook(() => useFileScrollMap());
    const { result: hook2 } = renderHook(() => useFileScrollMap());

    await waitFor(() => {
      expect(hook1.current[0]).toBe("minimap");
      expect(hook2.current[0]).toBe("minimap");
    });

    act(() => {
      testApi.__test.emit({
        type: "settings:updated",
        fileScrollMap: "marks",
      });
    });

    expect(hook1.current[0]).toBe("marks");
    expect(hook2.current[0]).toBe("marks");
  });

  it("optimistic set + PATCH", async () => {
    const patchSpy = vi.spyOn(testApi, "updateSettings");
    const { result } = renderHook(() => useFileScrollMap());

    act(() => {
      result.current[1]("marks");
    });

    expect(result.current[0]).toBe("marks");
    expect(patchSpy).toHaveBeenCalledWith({ fileScrollMap: "marks" });
  });

  it("reverts when updateSettings rejects", async () => {
    vi.spyOn(testApi, "updateSettings").mockRejectedValue(new Error("Network failure"));
    const { result } = renderHook(() => useFileScrollMap());

    expect(result.current[0]).toBe("minimap");

    act(() => {
      result.current[1]("marks");
    });

    // Optimistic change
    expect(result.current[0]).toBe("marks");

    // After failure, reverts back to minimap
    await waitFor(() => {
      expect(result.current[0]).toBe("minimap");
    });
  });
});
