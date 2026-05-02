import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { useSubscription } from "./useSubscription";

describe("useSubscription", () => {
  it("calls subscribe and cleanup on unmount", async () => {
    const api = createMockApi();
    const unsub = vi.spyOn(api, "subscribe");
    const { unmount } = renderHook(() => useSubscription(["sess-main"], api));
    await waitFor(() => expect(unsub).toHaveBeenCalledWith(["sess-main"]));
    unmount();
    expect(unsub).toHaveBeenCalled();
  });
});
