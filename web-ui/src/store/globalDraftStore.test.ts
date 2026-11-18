import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_DRAFT_CONFIG, useGlobalDraftStore } from "./globalDraftStore";

const KEY = "vst-global-draft";

/** What the persist middleware actually wrote to localStorage. */
function persisted(): { draft: { draftPrompt: string; draftConfig: unknown } | null } {
  const raw = localStorage.getItem(KEY);
  expect(raw).not.toBeNull();
  return (JSON.parse(raw!) as { state: { draft: { draftPrompt: string; draftConfig: unknown } | null } }).state;
}

describe("globalDraftStore (Decision 10 — one source of truth)", () => {
  beforeEach(() => {
    localStorage.clear();
    useGlobalDraftStore.setState({ draft: null });
  });

  it("prompt_never_persisted", () => {
    useGlobalDraftStore.getState().setDraft({
      draftPrompt: "half-written thought",
      draftConfig: { entryPoint: "global", modeId: "m1" },
    });
    // In memory the sidebar still renders the live text…
    expect(useGlobalDraftStore.getState().draft?.draftPrompt).toBe("half-written thought");
    // …but the prompt is the server-owned `global-new` draft's job, never ours:
    // persisting it would resurrect a cleared draft on the next load.
    expect(persisted().draft).toEqual({
      draftPrompt: "",
      draftConfig: { entryPoint: "global", modeId: "m1" },
    });
    expect(JSON.stringify(persisted())).not.toContain("half-written thought");
  });

  it("exports the Tier-2 default config the mirror falls back to", () => {
    expect(DEFAULT_GLOBAL_DRAFT_CONFIG).toEqual({ entryPoint: "global" });
  });
});
