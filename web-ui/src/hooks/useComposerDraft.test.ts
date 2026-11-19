import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { createMockApi } from "@/api/mock";
import { ensureDraftTextSync } from "@/components/draftsync";
import { engineFor } from "@/components/draftsync/engine";
import { loadDraft, useComposerDraft } from "./useComposerDraft";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useComposerDraft (server-owned drafts)", () => {
  it("legacy key is the first-paint read when no engine is ensured", () => {
    localStorage.setItem("vst-chat-draft-s1", "old");
    expect(loadDraft("s1")).toBe("old");
    const { result } = renderHook(() => useComposerDraft({} as ApiInstance, "s1", vi.fn()));
    expect(result.current.initialText).toBe("old");
    // Inert binding: no engine means no write can leave this test.
    act(() => {
      result.current.save("ignored");
      result.current.clear();
    });
    expect(localStorage.getItem("vst-chat-draft-s1")).toBe("old");
  });

  it("clear PUTs empty text for a scope already on the server", async () => {
    const api = createMockApi();
    await api.putDraftText("s1", "server text", "other");
    ensureDraftTextSync(api);
    await act(async () => {
      // Let the engine's initial fetch land before rendering the binding.
    });
    const put = vi.spyOn(api, "putDraftText");
    const { result, unmount } = renderHook(() => useComposerDraft(api, "s1", vi.fn()));
    expect(result.current.initialText).toBe("server text");

    act(() => result.current.clear());
    await waitFor(() => expect(put).toHaveBeenCalledWith("s1", "", expect.any(String), undefined));

    unmount();
    engineFor(api)?.stop();
  });
});
