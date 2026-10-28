import { parseErrorBody, ReviewApiError } from "./errors";
import type {
  ArtifactScopeKind,
  AttachCommentsRequest,
  AttachCommentsResponse,
  CommentErrorCode,
  CommentListResponse,
  CommentResponse,
  CreateCommentRequest,
  CreateTerminalDeliveryRequest,
  CreateTerminalDeliveryResponse,
  DetachCommentsRequest,
  DetachCommentsResponse,
  DismissRestoredResponse,
  PatchCommentRequest,
  RenderCommentsRequest,
  RenderCommentsResponse,
  RestoreReviewResponse,
  ReviewComment,
  TerminalReadiness,
  TerminalReadinessResponse,
} from "./types";

interface Deps {
  baseUrl: () => string;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

const seg = (kind: ArtifactScopeKind) => (kind === "project" ? "projects" : "worktrees");
const enc = encodeURIComponent;
const JSON_HEADERS = { "Content-Type": "application/json" };

/** Turn a failed response into a `ReviewApiError` (`{ error, message, remaining?, limit?, unit? }`). */
export async function reviewFailure(res: Response): Promise<never> {
  const { code, message, fields: j } = parseErrorBody(await res.text(), res.statusText);
  const info: ReviewApiError["info"] = {};
  if (typeof j.remaining === "number") info.remaining = j.remaining;
  if (typeof j.limit === "number") info.limit = j.limit;
  if (j.unit === "comments" || j.unit === "bytes") info.unit = j.unit;
  throw new ReviewApiError(message, res.status, code as CommentErrorCode | undefined, info);
}

/** Parse a review route's JSON, mapping failures through `reviewFailure`. */
export async function parseReviewJson<T>(res: Response): Promise<T> {
  if (!res.ok) return reviewFailure(res);
  return res.json() as Promise<T>;
}

/**
 * Review-comment REST methods. Kept out of `client.ts` (over the size guideline); spread into the client
 * object, mirrored by `mockComments.ts`. Every failure is a `ReviewApiError` with the daemon's error code.
 */
export function createCommentsClient({ baseUrl, apiFetch }: Deps) {
  const post = (url: string, body: unknown) =>
    apiFetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

  return {
    async listComments(
      scopeId: string,
      scopeKind: ArtifactScopeKind = "worktree",
      opts: { path?: string; delivery?: "unsent" | "all" } = {},
    ): Promise<CommentListResponse> {
      const q = new URLSearchParams();
      if (opts.path) q.set("path", opts.path);
      if (opts.delivery) q.set("delivery", opts.delivery);
      const qs = q.toString();
      const res = await apiFetch(`${baseUrl()}/${seg(scopeKind)}/${enc(scopeId)}/comments${qs ? `?${qs}` : ""}`);
      return parseReviewJson<CommentListResponse>(res);
    },

    async createComment(
      scopeId: string,
      scopeKind: ArtifactScopeKind,
      body: CreateCommentRequest,
    ): Promise<ReviewComment> {
      const res = await post(`${baseUrl()}/${seg(scopeKind)}/${enc(scopeId)}/comments`, body);
      return (await parseReviewJson<CommentResponse>(res)).comment;
    },

    async patchComment(id: string, body: PatchCommentRequest): Promise<ReviewComment> {
      const res = await apiFetch(`${baseUrl()}/comments/${enc(id)}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      return (await parseReviewJson<CommentResponse>(res)).comment;
    },

    async deleteComment(id: string): Promise<{ ok: true }> {
      const res = await apiFetch(`${baseUrl()}/comments/${enc(id)}`, { method: "DELETE" });
      return parseReviewJson<{ ok: true }>(res);
    },

    async attachComments(
      scopeId: string,
      scopeKind: ArtifactScopeKind,
      body: AttachCommentsRequest,
    ): Promise<AttachCommentsResponse> {
      const res = await post(`${baseUrl()}/${seg(scopeKind)}/${enc(scopeId)}/comments/attach`, body);
      return parseReviewJson<AttachCommentsResponse>(res);
    },

    async detachComments(
      scopeId: string,
      scopeKind: ArtifactScopeKind,
      body: DetachCommentsRequest,
    ): Promise<DetachCommentsResponse> {
      const res = await post(`${baseUrl()}/${seg(scopeKind)}/${enc(scopeId)}/comments/detach`, body);
      return parseReviewJson<DetachCommentsResponse>(res);
    },

    /** Copy as text: the daemon renders the Appendix A block (never size-limited). */
    async renderComments(
      scopeId: string,
      scopeKind: ArtifactScopeKind,
      body: RenderCommentsRequest,
    ): Promise<RenderCommentsResponse> {
      const res = await post(`${baseUrl()}/${seg(scopeKind)}/${enc(scopeId)}/comments/render`, body);
      return parseReviewJson<RenderCommentsResponse>(res);
    },

    async dismissRestoredComments(scopeId: string, scopeKind: ArtifactScopeKind): Promise<DismissRestoredResponse> {
      const res = await post(`${baseUrl()}/${seg(scopeKind)}/${enc(scopeId)}/comments/dismiss-restored`, {});
      return parseReviewJson<DismissRestoredResponse>(res);
    },

    /** "Restore to comments" on a sent card: skips pins already in the panel. */
    async restoreReview(sessionId: string, turnId: string): Promise<RestoreReviewResponse> {
      const res = await post(`${baseUrl()}/sessions/${enc(sessionId)}/chat/turns/${enc(turnId)}/restore-review`, {});
      return parseReviewJson<RestoreReviewResponse>(res);
    },

    async createTerminalDelivery(
      scopeId: string,
      scopeKind: ArtifactScopeKind,
      body: CreateTerminalDeliveryRequest,
    ): Promise<CreateTerminalDeliveryResponse> {
      const res = await post(`${baseUrl()}/${seg(scopeKind)}/${enc(scopeId)}/terminal-deliveries`, body);
      return parseReviewJson<CreateTerminalDeliveryResponse>(res);
    },

    /** Cancel + restore (409 `delivery_pasting` once the paste started). */
    async cancelTerminalDelivery(id: string): Promise<{ ok: true }> {
      const res = await apiFetch(`${baseUrl()}/terminal-deliveries/${enc(id)}`, { method: "DELETE" });
      return parseReviewJson<{ ok: true }>(res);
    },

    async terminalReadiness(sessionId: string): Promise<TerminalReadiness> {
      const res = await apiFetch(`${baseUrl()}/sessions/${enc(sessionId)}/terminal-readiness`);
      return (await parseReviewJson<TerminalReadinessResponse>(res)).readiness;
    },
  };
}
