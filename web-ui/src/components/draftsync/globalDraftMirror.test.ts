import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { createMockApi } from "@/api/mock";
import { GLOBAL_NEW_SCOPE } from "./constants";
import { ensureDraftTextSync } from "./engine";
import { engineFor } from "./engine";
import { DEFAULT_GLOBAL_DRAFT_CONFIG, useGlobalDraftStore } from "@/store/globalDraftStore";

const apis: ApiInstance[] = [];

function mockApi() {
  const api = createMockApi();
  apis.push(api);
  return api;
}

/** Ensure the page engine (which starts the mirror) and let its first fetch land. */
async function start(api: ApiInstance): Promise<void> {
  ensureDraftTextSync(api);
  await act(async () => {
    // the engine's one initial fetch
  });
}

function changed(api: ReturnType<typeof createMockApi>, text: string, revision: number, clientId = "phone") {
  return act(async () => {
    api.__test.emit({
      type: "draft-text:changed",
      scope: GLOBAL_NEW_SCOPE,
      text,
      revision,
      updatedAt: "2026-01-01T00:00:00.000Z",
      clientId,
    });
  });
}

describe("globalDraftMirror (Decision 10 — the sidebar mirrors global-new)", () => {
  beforeEach(() => {
    localStorage.clear();
    useGlobalDraftStore.setState({ draft: null });
    apis.length = 0;
  });

  afterEach(() => {
    for (const api of apis) engineFor(api)?.stop();
    vi.restoreAllMocks();
  });

  it("remote_creates_sidebar_draft_with_default_config", async () => {
    const api = mockApi();
    await start(api);
    await changed(api, "from phone", 1);
    expect(useGlobalDraftStore.getState().draft).toEqual({
      draftPrompt: "from phone",
      draftConfig: DEFAULT_GLOBAL_DRAFT_CONFIG,
    });
  });

  it("remote_clear_removes_it", async () => {
    const api = mockApi();
    await start(api);
    await changed(api, "from phone", 1);
    await changed(api, "", 2);
    expect(useGlobalDraftStore.getState().draft).toBeNull();
  });

  it("local_discard_clears_server_scope", async () => {
    const api = mockApi();
    await api.putDraftText(GLOBAL_NEW_SCOPE, "typed here", "phone");
    await start(api);
    expect(useGlobalDraftStore.getState().draft?.draftPrompt).toBe("typed here");
    const put = vi.spyOn(api, "putDraftText");

    act(() => useGlobalDraftStore.getState().clearDraft());

    expect(useGlobalDraftStore.getState().draft).toBeNull();
    expect(put).toHaveBeenCalledWith(GLOBAL_NEW_SCOPE, "", expect.any(String), undefined);
    expect((await api.getDraftText(GLOBAL_NEW_SCOPE)).text).toBe("");
  });
});
