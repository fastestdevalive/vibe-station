import { useSyncExternalStore } from "react";
import { matchPath, useLocation } from "react-router-dom";
import { useServerStore } from "@/hooks/useServerStore";
import type { Session } from "@/api/types";
import {
  getBackgroundStore,
  NEW_DRAFT_KEY,
  type BackgroundPrefs,
  type ScopeKey,
} from "./backgroundStore";
import type { ScreenKind } from "./resolveWallpaper";

/**
 * Which screen the current route is, in the terms `resolveWallpaper` speaks.
 *
 * Read-only: it never writes the store (a write during render would be an
 * infinite render loop); the writes that belong to a route live in
 * `useBackground`'s effects.
 */
export interface WallpaperScope {
  kind: ScreenKind;
  /** `empty` = a new-agent draft screen (mobile's larger visibility default); every other screen is `session`. */
  view: "empty" | "session";
  /** Present only for `/draft/*` routes. */
  draftId?: string;
}

const APP_SCOPE: WallpaperScope = { kind: { t: "app" }, view: "session" };

function sessionById(sessions: Session[], id: string | undefined): Session | undefined {
  if (id === undefined) return undefined;
  return sessions.find((s) => s.id === id);
}

function worktreeScope(wtId: string | undefined): WallpaperScope {
  if (wtId === undefined) return APP_SCOPE;
  return { kind: { t: "scope", scope: `worktree:${wtId}` as ScopeKey }, view: "session" };
}

function projectScope(projectId: string | undefined): WallpaperScope {
  if (projectId === undefined) return APP_SCOPE;
  return { kind: { t: "scope", scope: `project:${projectId}` as ScopeKey }, view: "session" };
}

function resolveScope(pathname: string, sessions: Session[], prefs: BackgroundPrefs): WallpaperScope {
  // `/draft/new` first: `/draft/:draftSessionId` would otherwise match "new".
  if (matchPath("/draft/new", pathname) !== null) {
    return {
      kind: { t: "draft", ownId: prefs.drafts[NEW_DRAFT_KEY] ?? null },
      view: "empty",
      draftId: NEW_DRAFT_KEY,
    };
  }

  const draft = matchPath("/draft/:draftSessionId", pathname);
  if (draft !== null) {
    const draftId = draft.params.draftSessionId;
    if (draftId === undefined) return APP_SCOPE;
    // A draft that already lives in a worktree is a "tab draft": it follows that
    // worktree's wallpaper instead of claiming one of its own (mobile parity: tabs inherit their worktree wallpaper).
    const worktreeId = sessionById(sessions, draftId)?.worktreeId ?? null;
    return {
      kind: {
        t: "draft",
        ownId: prefs.drafts[draftId] ?? null,
        tabScope: worktreeId ? (`worktree:${worktreeId}` as ScopeKey) : undefined,
      },
      view: "empty",
      draftId,
    };
  }

  // Worktree and project screens are always session views, even before the first session exists or
  // while the URL carries no session id (the last-open session is shown without one).
  const wt = matchPath("/worktree/:wtId/*", pathname);
  if (wt !== null) return worktreeScope(wt.params.wtId);

  const proj = matchPath("/project/:projectId/*", pathname);
  if (proj !== null) return projectScope(proj.params.projectId);

  const direct = matchPath("/session/:directSessionId", pathname);
  if (direct !== null) {
    const session = sessionById(sessions, direct.params.directSessionId);
    // A direct session shows its project's screen; no project (global draft) ⇒ app.
    if (session === undefined || session.projectId == null) return APP_SCOPE;
    return projectScope(session.projectId);
  }

  // `/`, `/worktree`, `/settings*`, `/workspaces/*` and anything unknown.
  return APP_SCOPE;
}

export function useWallpaperScope(): WallpaperScope {
  const { pathname } = useLocation();
  const sessions = useServerStore((s) => s.sessions);
  const store = getBackgroundStore();
  const prefs = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return resolveScope(pathname, sessions, prefs);
}
