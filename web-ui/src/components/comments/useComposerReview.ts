import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ApiInstance } from "@/api";
import type { ReviewComment } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useCommentScopeLoad } from "./useCommentsSync";
import { useScopeComments } from "./commentSelectors";
import { attachToComposer, composerKeyFor, detachFromComposer, reviewErrorText, type ReviewScope } from "./reviewActions";
import { useApiOnline } from "./useApiOnline";

/** Lease touches while the user works in the composer are throttled to one per 5 minutes (the lease is 30). */
export const LEASE_TOUCH_MS = 5 * 60 * 1000;

/** The comment scope a session's composer belongs to: its worktree, else the project of a direct session. */
export function useSessionReviewScope(sessionId: string | null | undefined): ReviewScope | null {
  const worktreeId = useServerStore((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId)?.worktreeId : undefined));
  const projectId = useServerStore((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId)?.projectId : undefined));
  return useMemo(() => {
    if (worktreeId) return { scopeKind: "worktree", scopeId: worktreeId };
    if (projectId) return { scopeKind: "project", scopeId: projectId };
    return null;
  }, [worktreeId, projectId]);
}

export interface ComposerReview {
  scope: ReviewScope | null;
  /** Comments in the panel (any delivery state). The button is hidden at 0. */
  total: number;
  /** Comments attached to THIS composer: what the chip shows and what Enter sends. */
  attached: ReviewComment[];
  attachedIds: string[];
  /** Comments in the panel that are not on this composer (new, or attached elsewhere): the button's `+N`. */
  other: number;
  online: boolean;
  busy: boolean;
  error: string | null;
  /** Press of the Attach button: detach when plainly attached, else attach all (moves the rest here). */
  toggle: () => Promise<void>;
  detach: () => Promise<void>;
  clearError: () => void;
  /** Re-read after a failed send (`comments_changed`). */
  setError: (message: string | null) => void;
}

/**
 * Everything the composer's Attach button and chip derive from `useCommentStore` (one source of server state,
 * R134): this composer's attached comments, the panel total and the `+N` of comments it does not hold. `rootRef`
 * is the composer element; typing or focus inside it refreshes the 30-minute lease at most every 5 minutes.
 */
export function useComposerReview(
  api: ApiInstance,
  sessionId: string,
  rootRef?: RefObject<HTMLElement | null>,
): ComposerReview {
  const scope = useSessionReviewScope(sessionId);
  useCommentScopeLoad(api, scope?.scopeKind ?? "worktree", scope?.scopeId);
  const comments = useScopeComments(scope?.scopeId);
  const online = useApiOnline(api);
  const key = composerKeyFor(sessionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attached = useMemo(() => comments.filter((c) => c.attachedTo === key), [comments, key]);
  const attachedIds = useMemo(() => attached.map((c) => c.id), [attached]);
  const total = comments.length;
  const other = total - attached.length;

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (!scope || busy) return;
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(reviewErrorText(e, api, scope));
      } finally {
        setBusy(false);
      }
    },
    [api, scope, busy],
  );

  const detach = useCallback(
    () => run(() => detachFromComposer(api, scope!, { sessionId })),
    [run, api, scope, sessionId],
  );
  const toggle = useCallback(
    () =>
      attached.length > 0 && other === 0
        ? detach()
        : run(() => attachToComposer(api, scope!, sessionId)),
    [attached.length, other, detach, run, api, scope, sessionId],
  );

  // Keep the lease alive while the user is working in this composer.
  const lastTouch = useRef(Date.now());
  const hasAttached = attached.length > 0;
  useEffect(() => {
    const el = rootRef?.current;
    if (!el || !scope || !hasAttached) return undefined;
    lastTouch.current = Date.now();
    const touch = () => {
      const now = Date.now();
      if (now - lastTouch.current < LEASE_TOUCH_MS) return;
      lastTouch.current = now;
      void api
        .attachComments(scope.scopeId, scope.scopeKind, { composerKey: key, refreshOnly: true })
        .catch(() => {});
    };
    el.addEventListener("focusin", touch);
    el.addEventListener("keydown", touch);
    return () => {
      el.removeEventListener("focusin", touch);
      el.removeEventListener("keydown", touch);
    };
  }, [api, scope, key, hasAttached, rootRef]);

  return {
    scope,
    total,
    attached,
    attachedIds,
    other,
    online,
    busy,
    error,
    toggle,
    detach,
    clearError: () => setError(null),
    setError,
  };
}
