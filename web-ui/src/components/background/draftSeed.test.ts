import { beforeEach, describe, expect, it } from "vitest";
import { __resetBackgroundStoreForTests, getBackgroundStore } from "./backgroundStore";
import { seedFromDraftStart } from "./draftSeed";

/** Claim a draft's own wallpaper the way `useBackground` does on `/draft/*`. */
function claimDraft(draftKey: string, id: string): void {
  getBackgroundStore().draftWallpaperFor(draftKey, [id]);
}

describe("seedFromDraftStart", () => {
  beforeEach(() => {
    __resetBackgroundStoreForTests();
  });

  it("copies the stored draft id to the worktree seed", () => {
    claimDraft("d1", "wp-007");

    seedFromDraftStart({ draftKey: "d1", worktreeId: "w1" });

    expect(getBackgroundStore().getState().seeds["worktree:w1"]).toBe("wp-007");
  });

  it("also seeds a created project", () => {
    claimDraft("d1", "wp-007");

    seedFromDraftStart({ draftKey: "d1", worktreeId: "w1", createdProjectId: "p1" });

    const seeds = getBackgroundStore().getState().seeds;
    expect(seeds["worktree:w1"]).toBe("wp-007");
    expect(seeds["project:p1"]).toBe("wp-007");
  });

  it("no stored draft id writes nothing", () => {
    seedFromDraftStart({ draftKey: "d1", worktreeId: "w1", createdProjectId: "p1" });

    const state = getBackgroundStore().getState();
    expect(state.seeds).toEqual({});
    expect(state.drafts).toEqual({});
  });

  it("never overwrites an existing seed", () => {
    getBackgroundStore().writeSeedIfAbsent("worktree:w1", "wp-002");
    claimDraft("d1", "wp-007");

    seedFromDraftStart({ draftKey: "d1", worktreeId: "w1" });

    expect(getBackgroundStore().getState().seeds["worktree:w1"]).toBe("wp-002");
  });

  it("forgets the draft key", () => {
    claimDraft("d1", "wp-007");

    seedFromDraftStart({ draftKey: "d1", worktreeId: "w1" });

    expect(getBackgroundStore().getState().drafts["d1"]).toBeUndefined();
  });
});
