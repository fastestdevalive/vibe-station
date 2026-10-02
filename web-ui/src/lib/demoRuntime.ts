/**
 * Non-React seams of the website's inline demos (inline-demos Decisions 4 and 8). The website mounts the
 * REAL app several times in one page (m1, m2, m3 in turn); every singleton the app keeps at module level
 * must therefore be returned to its freshly-imported state before the next mount.
 */
import { useWorkspaceStore, __resetForDemo as resetWorkspaceModule } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { useModesStore, __resetForDemo as resetModes } from "@/store/modesStore";
import { useGlobalDraftStore } from "@/store/globalDraftStore";
import { useThemeStore, DEFAULT_FONT } from "@/hooks/useThemeStore";
import { useResetProgress } from "@/hooks/useResetProgress";
import { __resetForDemo as resetSessionReset } from "@/hooks/useSessionReset";
import { useMarkdownStyleStore, __resetForDemo as resetMarkdownStyle, reapplyMarkdownStyle } from "@/hooks/useMarkdownStyle";
import { __resetForDemo as resetTheme } from "@/hooks/useTheme";
import { __resetForDemo as resetServerSync } from "@/hooks/useServerSync";
import { __resetForDemo as resetDiffViews } from "@/preview/diffViewRegistry";
import { __resetForDemo as resetTabsStrip } from "@/components/layout/TabsStrip";
import * as chatSnapshotCache from "@/hooks/chatSnapshotCache";
import { defaultThemeId } from "@/theme/registry";

export { setThemeRoot, getThemeRoot, setStyleHost, getStyleHost } from "./demoRoots";

/** Every zustand store of the app (a unit test asserts this equals the `= create<` stores in src). */
export const APP_STORES = [
  useWorkspaceStore,
  useServerStore,
  useModesStore,
  useGlobalDraftStore,
  useThemeStore,
  useMarkdownStyleStore,
  useResetProgress,
] as const;

/** Return every module-level singleton to its freshly-imported state (persisted stores re-read the storage). */
export function resetAppSingletons(): void {
  resetMarkdownStyle();
  resetTheme();
  resetModes();
  resetServerSync();
  resetDiffViews();
  resetTabsStrip();
  resetSessionReset();
  resetWorkspaceModule();
  chatSnapshotCache.clear();
  // zustand `persist` writes through on every `setState` — resetting would overwrite the freshly seeded
  // storage with the initial state. Snapshot the persisted keys first and put them back before rehydrating.
  const persistedKeys = [useWorkspaceStore, useGlobalDraftStore].map((st) => st.persist.getOptions().name as string);
  const snapshot = persistedKeys.map((k) => [k, localStorage.getItem(k)] as const);
  for (const store of APP_STORES) {
    (store as { setState(s: unknown, replace: boolean): void; getInitialState(): unknown }).setState(
      (store as { getInitialState(): unknown }).getInitialState(),
      true,
    );
  }
  for (const [k, v] of snapshot) {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  }
  // persisted stores hydrate from the (freshly seeded) storage
  void useWorkspaceStore.persist.rehydrate();
  void useGlobalDraftStore.persist.rehydrate();
  // the (new) theme root starts from the default attributes; useTheme's boot then applies the cached/server value
  useThemeStore.getState().setThemeId(defaultThemeId);
  useThemeStore.getState().setFont(DEFAULT_FONT);
  reapplyMarkdownStyle();
}
