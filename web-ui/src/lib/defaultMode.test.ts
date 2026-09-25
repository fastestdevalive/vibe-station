import { beforeEach, describe, expect, it } from "vitest";
import { createMockApi } from "@/api/mock";
import { useModesStore } from "@/store/modesStore";
import { resolveDefaultModeId } from "./defaultMode";

describe("resolveDefaultModeId (2.1 / 2.T1)", () => {
  beforeEach(() => {
    useModesStore.getState()._reset();
  });

  it("awaits ensureLoaded then returns the first mode's id from the Map", async () => {
    const api = createMockApi();
    const id = await resolveDefaultModeId(api);
    // The mock api's seeded modes are mode-1, mode-2 — mode-1 is first.
    expect(id).toBe("mode-1");
    expect(useModesStore.getState().loaded).toBe(true);
  });

  it("returns null when the modes Map is empty", async () => {
    // Simulate an already-loaded store with no modes so ensureLoaded no-ops.
    useModesStore.setState({ modes: new Map(), loaded: true });
    const api = createMockApi();
    const id = await resolveDefaultModeId(api);
    expect(id).toBeNull();
  });
});
