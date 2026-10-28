import type { ApiInstance } from "@/api";
import { ReviewApiError } from "@/api/errors";
import type { ArtifactScopeKind, TerminalDelivery } from "@/api/types";
import { appendComposerDraft } from "@/hooks/useComposerDraft";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { apiErrorText } from "@/lib/apiErrorText";
import { createProjectDirectDraft } from "@/lib/projectDraft";
import { copyText } from "@/lib/copyText";
import { renderDraftText, toPlainText, toWire } from "@/lib/mentions";
import { plural } from "@/lib/plural";
import { randomId } from "@/lib/uuid";
import { fetchCommentScope } from "./useCommentsSync";
import { useCommentStore } from "./useCommentStore";

/** The comment scope a send acts on (a worktree, or the project of a direct session). */
export interface ReviewScope {
  scopeKind: ArtifactScopeKind;
  scopeId: string;
}

/** `session:<id>`: the composer key comments are attached to (a draft's id is its future session id). */
export const composerKeyFor = (sessionId: string) => `session:${sessionId}`;


/**
 * Text for a failed send / attach / schedule. `comments_changed` also refreshes the scope so the picker and the
 * tray show what is really left (nothing was sent); the others name the limit or the conflict.
 */
export function reviewErrorText(e: unknown, api?: Pick<ApiInstance, "listComments">, scope?: ReviewScope): string {
  if (e instanceof ReviewApiError) {
    switch (e.code) {
      case "comments_changed": {
        if (api && scope) void fetchCommentScope(api, scope.scopeKind, scope.scopeId);
        const n = e.info.remaining;
        return n == null
          ? "Some comments changed, review and send again"
          : `${plural(n, "comment", "comments")} changed, review and send again`;
      }
      case "review_too_large":
        return "Send fewer or copy as text";
      case "not_attached":
        return "These comments are attached to another agent’s chat box. Detach them first";
      case "delivery_in_flight":
        return "A send to this agent is already in progress";
      case "delivery_pasting":
        return "Already pasting, it can't be cancelled now";
      case "TERMINAL_DELIVERY_UNSUPPORTED":
        return "This agent can't take comments in its terminal";
      case "scope_changed":
        return "This agent would start in a different worktree";
      default:
        return apiErrorText(e, "Couldn't send the comments.");
    }
  }
  return apiErrorText(e, "Couldn't send the comments.");
}

/**
 * Send to a Rich Chat agent: one queued turn (never steers) carrying the picker's message (draft form converted
 * with `toWire`, the Rich Chat seam) and the comments. The rows leave the panel at once (R67).
 */
export async function sendToRichChat(
  api: ApiInstance,
  scope: ReviewScope,
  sessionId: string,
  commentIds: string[],
  messageDraft: string,
): Promise<void> {
  const w = toWire(messageDraft.trim());
  await api.sendChat(sessionId, w.text, undefined, true, w.mentions.length ? w.mentions : undefined, commentIds);
  useCommentStore.getState().removeLocal(scope.scopeId, commentIds);
}

/**
 * Send to a Terminal agent: a durable delivery row the daemon pastes once the agent is ready. The message goes
 * out as plain text (`renderDraftText`, files stay `@path`, R130), never `toWire`'s escaped form.
 */
export async function sendToTerminal(
  api: ApiInstance,
  scope: ReviewScope,
  sessionId: string,
  commentIds: string[],
  messageDraft: string,
): Promise<TerminalDelivery> {
  const message = renderDraftText(messageDraft).trim();
  const res = await api.createTerminalDelivery(scope.scopeId, scope.scopeKind, {
    terminalDeliveryId: randomId(),
    sessionId,
    commentIds,
    ...(message ? { message } : {}),
  });
  const store = useCommentStore.getState();
  store.removeLocal(scope.scopeId, commentIds);
  store.applyDelivery(res.delivery);
  return res.delivery;
}

/**
 * Schedule a review for later (either channel, PRD R118): the daemon snapshots the comment rows onto the scheduled
 * message (`reviewCommentIds`) and fires it as a turn / a terminal delivery at `fireAtIso`. The text follows the
 * target channel, like the composer's own schedule path: a Rich Chat agent gets the sidecar-less wire form
 * (`toPlainText`: `/skill` tokens and escaped braces survive until it fires), a Terminal agent the plain rendering
 * (`renderDraftText`, files stay `@path`). It is optional with comments attached.
 */
export async function scheduleReview(
  api: ApiInstance,
  scope: ReviewScope,
  sessionId: string,
  commentIds: string[],
  messageDraft: string,
  fireAtIso: string,
  target: "rich" | "terminal" | "none",
): Promise<void> {
  const text = target === "rich" ? toPlainText(messageDraft) : renderDraftText(messageDraft);
  await api.scheduleMessage(sessionId, text.trim(), fireAtIso, undefined, commentIds);
  useCommentStore.getState().removeLocal(scope.scopeId, commentIds);
}

/** Retry a timed-out / failed Terminal send over the comments that came back (a NEW delivery id). */
export async function retryDelivery(api: ApiInstance, scope: ReviewScope, d: TerminalDelivery): Promise<TerminalDelivery> {
  const present = new Set((useCommentStore.getState().byScope[scope.scopeId]?.comments ?? []).map((c) => c.id));
  const ids = d.commentIds.filter((id) => present.has(id));
  const res = await api.createTerminalDelivery(scope.scopeId, scope.scopeKind, {
    terminalDeliveryId: randomId(),
    sessionId: d.sessionId,
    commentIds: ids,
    ...(d.message ? { message: d.message } : {}),
  });
  const store = useCommentStore.getState();
  store.dropDelivery(scope.scopeId, d.id);
  store.removeLocal(scope.scopeId, ids);
  store.applyDelivery(res.delivery);
  return res.delivery;
}

/** Copy as text: the daemon renders the one Appendix A message (message first); nothing is marked sent. */
export async function copyReviewAsText(
  api: ApiInstance,
  scope: ReviewScope,
  commentIds: string[],
  messageDraft = "",
): Promise<boolean> {
  const message = renderDraftText(messageDraft).trim();
  const res = await api.renderComments(scope.scopeId, scope.scopeKind, {
    commentIds,
    ...(message ? { message } : {}),
  });
  return copyText(res.text);
}

/** Attach comments to a composer (moves them from any other); the response is applied at once, the event follows. */
export async function attachToComposer(
  api: ApiInstance,
  scope: ReviewScope,
  sessionId: string,
  commentIds?: string[],
): Promise<string[]> {
  const key = composerKeyFor(sessionId);
  const res = await api.attachComments(scope.scopeId, scope.scopeKind, {
    composerKey: key,
    ...(commentIds ? { commentIds } : {}),
  });
  useCommentStore.getState().setAttachedLocal(scope.scopeId, res.attached, key);
  return res.attached;
}

/** Release comments from a composer (any client may). */
export async function detachFromComposer(
  api: ApiInstance,
  scope: ReviewScope,
  opts: { sessionId?: string; commentIds?: string[] } = {},
): Promise<string[]> {
  const res = await api.detachComments(scope.scopeId, scope.scopeKind, {
    ...(opts.sessionId ? { composerKey: composerKeyFor(opts.sessionId) } : {}),
    ...(opts.commentIds ? { commentIds: opts.commentIds } : {}),
  });
  useCommentStore.getState().setAttachedLocal(scope.scopeId, res.detached, undefined);
  return res.detached;
}

/**
 * Picker row "Attach" (R68): attach the checked comments to that Rich Chat agent's composer, hand it the
 * picker's message as its draft (draft form, unconverted; appended on a new line when the composer already has
 * text) and switch to its tab. Nothing is sent: the user presses Enter there.
 */
export async function attachFromPicker(
  api: ApiInstance,
  scope: ReviewScope,
  sessionId: string,
  commentIds: string[],
  messageDraft: string,
): Promise<void> {
  await attachToComposer(api, scope, sessionId, commentIds);
  appendComposerDraft(sessionId, messageDraft.trim());
  useWorkspaceStore.getState().setActiveSession(sessionId);
}

/**
 * "New agent with these comments" (R63): a Tier-1 draft in the same worktree (the project for direct sessions)
 * with the comments attached to `session:<draftId>` and the picker's message as its prompt, opened in the
 * draft composer (which shows the chip). Nothing starts until the user presses Start.
 */
export async function newAgentWithComments(
  api: ApiInstance,
  scope: ReviewScope,
  commentIds: string[],
  messageDraft: string,
): Promise<string> {
  const draft =
    scope.scopeKind === "project"
      ? await createProjectDirectDraft(api, scope.scopeId)
      : await api.createDraftSession({
          target: "worktree",
          worktreeId: scope.scopeId,
          type: "agent",
          draftConfig: { entryPoint: "tab" },
        });
  if (scope.scopeKind !== "project") useServerStore.getState().applySessionCreated(draft);
  await attachToComposer(api, scope, draft.id, commentIds);
  const prompt = messageDraft.trim();
  if (prompt) {
    await api.updateDraft(draft.id, { draftPrompt: prompt, draftConfig: draft.draftConfig ?? { entryPoint: "tab" } });
    useServerStore.getState().applySessionUpdated(draft.id, { draftPrompt: prompt });
  }
  useWorkspaceStore.getState().setActiveSession(draft.id);
  return draft.id;
}
