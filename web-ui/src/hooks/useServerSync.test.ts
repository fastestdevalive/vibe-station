import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { useServerSync } from "./useServerSync";
import { useServerStore } from "./useServerStore";

/**
 * 1.T4 — the daemon already broadcasts `name`/`archivedAt` (and now
 * `sortOrder`) on `session:updated`; the client used to drop them (Research,
 * Superseded row). Verify the patch-building `if` chain in useServerSync.ts
 * applies each field when present, and leaves it alone when absent.
 */
describe("useServerSync — session:updated reconciliation", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
  });

  it("applies name and archivedAt from a session:updated event", async () => {
    const api = createMockApi();
    renderHook(() => useServerSync(api));

    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "session:updated",
        sessionId: "sess-main",
        name: "renamed-session",
        archivedAt: "2026-01-01T00:00:00.000Z",
      });
    });

    await waitFor(() => {
      const s = useServerStore.getState().sessions.find((x) => x.id === "sess-main");
      expect(s?.name).toBe("renamed-session");
      expect(s?.archivedAt).toBe("2026-01-01T00:00:00.000Z");
    });
  });

  it("clears name back to null when the event carries name: null", async () => {
    const api = createMockApi();
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({ type: "session:updated", sessionId: "sess-main", name: null });
    });

    await waitFor(() => {
      const s = useServerStore.getState().sessions.find((x) => x.id === "sess-main");
      expect(s?.name).toBeNull();
    });
  });

  it("applies sortOrder from a session:updated event", async () => {
    const api = createMockApi();
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({ type: "session:updated", sessionId: "sess-main", sortOrder: 42 });
    });

    await waitFor(() => {
      const s = useServerStore.getState().sessions.find((x) => x.id === "sess-main");
      expect(s?.sortOrder).toBe(42);
    });
  });

  it("leaves unrelated fields untouched when only pinnedAt is present", async () => {
    const api = createMockApi();
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    const before = useServerStore.getState().sessions.find((x) => x.id === "sess-main");

    act(() => {
      api.__test.emit({ type: "session:updated", sessionId: "sess-main", pinnedAt: "2026-01-01T00:00:00.000Z" });
    });

    await waitFor(() => {
      const s = useServerStore.getState().sessions.find((x) => x.id === "sess-main");
      expect(s?.pinnedAt).toBe("2026-01-01T00:00:00.000Z");
    });
    const after = useServerStore.getState().sessions.find((x) => x.id === "sess-main");
    expect(after?.name).toBe(before?.name);
    expect(after?.archivedAt).toBe(before?.archivedAt);
  });
});
