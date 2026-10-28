import type { ArtifactScopeKind, CommentListResponse, ReviewComment, TerminalDelivery } from "@/api/types";
import { useCommentStore } from "./useCommentStore";

/** Scenarios of the state simulator's Comments section (the `Send` board B tray states and the list-row states). */
export const COMMENTS_DEV_SCENARIOS = [
  "normal",
  "attached",
  "sending · waiting",
  "sending · pasting",
  "restored",
  "timed out",
  "agent exited",
  "over limit",
  "row states",
] as const;
export type CommentsDevScenario = (typeof COMMENTS_DEV_SCENARIOS)[number];

function comment(scopeKind: ArtifactScopeKind, scopeId: string, pin: number, over: Partial<ReviewComment> = {}): ReviewComment {
  const now = new Date().toISOString();
  return {
    id: `dev-comment-${pin}`,
    scopeKind,
    scopeId,
    pin,
    path: pin % 2 ? "src/components/layout/FilesLeftRail.tsx" : "src/components/layout/ToolPanel.tsx",
    pathKind: "repo",
    surface: "file",
    lineStart: 100 + pin,
    lineEnd: 100 + pin,
    quote: `quoted text ${pin}`,
    prefix: "",
    suffix: "",
    occurrence: 0,
    text: `Dev comment ${pin}`,
    anchor: "anchored",
    blockBytes: 120,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/**
 * Build the list response a scenario stands for. Pure; `sessionId` is the agent the delivery / attach states
 * point at. Client-only: a real `comments:changed` or a reload puts server truth back.
 */
export function devCommentsResponse(
  scenario: CommentsDevScenario,
  scopeKind: ArtifactScopeKind,
  scopeId: string,
  sessionId: string,
): CommentListResponse {
  const c = (pin: number, over: Partial<ReviewComment> = {}) => comment(scopeKind, scopeId, pin, over);
  const delivery = (state: TerminalDelivery["state"], over: Partial<TerminalDelivery> = {}): TerminalDelivery => ({
    id: `dev-delivery-${state}`,
    scopeKind,
    scopeId,
    sessionId,
    state,
    commentIds: ["dev-comment-1", "dev-comment-2", "dev-comment-3"],
    commentCount: 3,
    bytes: 900,
    updatedAt: new Date().toISOString(),
    ...over,
  });
  const three = [c(1), c(2), c(3)];
  switch (scenario) {
    case "normal":
      return { comments: [...three, c(4)], nextPin: 5, terminalDeliveries: [] };
    case "attached":
      return {
        comments: [c(1, { attachedTo: `session:${sessionId}` }), c(2, { attachedTo: `session:${sessionId}` }), c(3)],
        nextPin: 4,
        terminalDeliveries: [],
      };
    case "sending · waiting":
      return { comments: [], nextPin: 4, terminalDeliveries: [delivery("waiting", { waitsBehind: 1 })] };
    case "sending · pasting":
      return { comments: [], nextPin: 4, terminalDeliveries: [delivery("pasting")] };
    case "restored":
      return { comments: three.map((x) => ({ ...x, restoredReason: "turn_cancelled" as const })), nextPin: 4, terminalDeliveries: [] };
    case "timed out":
      return { comments: three, nextPin: 4, terminalDeliveries: [delivery("timed_out", { reason: "timed_out" })] };
    case "agent exited":
      return { comments: three, nextPin: 4, terminalDeliveries: [delivery("failed", { reason: "agent_exited" })] };
    case "over limit":
      return {
        comments: Array.from({ length: 212 }, (_, i) => c(i + 1, { id: `dev-comment-${i + 1}`, blockBytes: 700 })),
        nextPin: 213,
        terminalDeliveries: [],
      };
    case "row states":
      return {
        comments: [
          c(1),
          c(2, { anchor: "outdated" }),
          c(3, { anchor: "file_missing", path: "docs/removed.md" }),
          c(4, { anchor: "cant_check", anchorReason: "file_too_large", path: "docs/huge-log.md" }),
          c(5, { anchor: "cant_check", anchorReason: "watch_limit", path: "src/generated/api.ts" }),
          c(6, { pathKind: "artifact", path: "/tmp/mockups/rail-right.html" }),
          c(7, { attachedTo: `session:${sessionId}` }),
        ],
        nextPin: 8,
        terminalDeliveries: [],
      };
  }
}

/** Put a scenario into the comment store (client-only). */
export function applyCommentsDevScenario(
  scenario: CommentsDevScenario,
  scopeKind: ArtifactScopeKind,
  scopeId: string,
  sessionId: string,
): void {
  useCommentStore.getState().replace(scopeId, scopeKind, devCommentsResponse(scenario, scopeKind, scopeId, sessionId));
}

/** Drop the fake: mark the scope stale so the sync hook refetches the daemon's truth. */
export function clearCommentsDevScenario(): void {
  useCommentStore.getState().markAllStale();
}
