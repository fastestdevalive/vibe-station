import { getBackgroundStore } from "./backgroundStore";

/**
 * Copies a draft's own wallpaper into the scopes a successful Start created
 * (mobile parity): the seed is written once, from the `/start` response
 * itself, so the new agent keeps the wallpaper the draft was composed with even
 * if the catalog later changes order. Nothing is written when the draft never
 * claimed an id (e.g. "Own wallpaper per agent" was off).
 */
export interface DraftSeedArgs {
  draftKey: string;
  worktreeId?: string;
  createdProjectId?: string;
}

export function seedFromDraftStart({ draftKey, worktreeId, createdProjectId }: DraftSeedArgs): void {
  const store = getBackgroundStore();
  const own = store.getState().drafts[draftKey];
  if (own === undefined) return;

  if (worktreeId !== undefined) store.writeSeedIfAbsent(`worktree:${worktreeId}`, own);
  if (createdProjectId !== undefined) store.writeSeedIfAbsent(`project:${createdProjectId}`, own);
  store.forgetDraft(draftKey);
}

/**
 * A draft keeps the wallpaper it opened with while composing (mobile parity): when
 * choosing a project re-keys the draft to a new session id, carry the claimed id
 * across so the image does not swap mid-composition.
 */
export function carryDraftWallpaper(fromKey: string, toKey: string): void {
  getBackgroundStore().moveDraft(fromKey, toKey);
}
