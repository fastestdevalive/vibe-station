import { beforeEach, describe, it, expect, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import {
  useModesStore,
  ensureLoaded,
  subscribeModes,
  iconForMode,
} from "./modesStore";
import type { Mode } from "@/api/types";

describe("modesStore (2.T2 — created/updated/deleted events)", () => {
  beforeEach(() => {
    useModesStore.getState()._reset();
  });

  it("ensureLoaded populates the cache from the API (idempotent)", async () => {
    const api = createMockApi();
    await ensureLoaded(api);
    expect(useModesStore.getState().loaded).toBe(true);
    expect(useModesStore.getState().modes.size).toBeGreaterThan(0);
    expect(iconForMode("mode-1")).toBe("claude");

    const first = useModesStore.getState().modes;
    await ensureLoaded(api);
    expect(useModesStore.getState().modes).toBe(first);
  });

  it("mode:created adds a mode to the cache and resolves its icon", async () => {
    const api = createMockApi();
    subscribeModes(api);
    const created = await api.createMode({ name: "New", cli: "opencode", context: "c", model: "deepseek-local/x", icon: "deepseek" });
    expect(useModesStore.getState().modes.get(created.id)?.icon).toBe("deepseek");
    expect(iconForMode(created.id)).toBe("deepseek");
  });

  it("mode:updated replaces the cached mode and its icon", async () => {
    const api = createMockApi();
    subscribeModes(api);
    const created = await api.createMode({ name: "New", cli: "opencode", context: "c", icon: "opencode" });
    await api.updateMode(created.id, { icon: "deepseek" });
    expect(iconForMode(created.id)).toBe("deepseek");
  });

  it("mode:deleted removes the mode from the cache (icon -> null)", async () => {
    const api = createMockApi();
    subscribeModes(api);
    const created = await api.createMode({ name: "New", cli: "claude", context: "c", icon: "claude" });
    expect(iconForMode(created.id)).toBe("claude");
    await api.deleteMode(created.id);
    expect(iconForMode(created.id)).toBeNull();
  });

  it("iconForMode returns null for null/unknown modeId", () => {
    expect(iconForMode(null)).toBeNull();
    expect(iconForMode(undefined)).toBeNull();
    expect(iconForMode("does-not-exist")).toBeNull();
  });

  it("subscribeModes returns an unsubscribe that stops further updates", async () => {
    const api = createMockApi();
    const unsub = subscribeModes(api);
    const created = await api.createMode({ name: "New", cli: "claude", context: "c", icon: "claude" });
    unsub();
    await api.updateMode(created.id, { icon: "cursor" });
    // Store is no longer subscribed: icon stays at the last-seen value.
    expect(iconForMode(created.id)).toBe("claude");
  });

  it("concurrent ensureLoaded calls share one request", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "listModes");
    await Promise.all([ensureLoaded(api), ensureLoaded(api), ensureLoaded(api)]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
