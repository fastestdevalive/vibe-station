import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";

/**
 * Create a direct-agent DRAFT (not a live agent) in a project's base
 * directory, opened as a tab in the project workspace — the shared path for
 * every "new direct agent" entry point in project scope (TabsStrip's "+",
 * ProjectHomeTab's "New direct agent" button, and the sidebar's "+" menu),
 * so they all behave identically (plan-04-tab-sidebar-ux-fixes.md items 3/4).
 *
 * `entryPoint: "tab"` tells `DraftComposer` to hide the project/worktree
 * fields (they're implied by context) and, on the daemon side, starts the
 * draft as a worktree-less direct session with no git gate — mirroring the
 * worktree-scope "+" button's existing `createDraftSession({ target:
 * "worktree", draftConfig: { entryPoint: "tab" } })` call.
 *
 * Registers the full HTTP response (which includes `draftConfig`) with the
 * store immediately, BEFORE the `session:created` WS broadcast's narrower
 * snapshot can arrive — every other draft-creation call site does this
 * (`LeftSidebar.tsx`, `DraftComposer.tsx`, the worktree "+" button above);
 * skipping it would leave `draftConfig` unset until the WS echo lands, and
 * `DraftComposer` would render the wrong composer UI in the meantime.
 *
 * Does NOT open the tab (`openProjectAgentTab`) or activate it
 * (`setActiveSession`) itself — callers do that in the order their own call
 * site requires (see item 4's note on why sidebar-initiated drafts must
 * navigate before opening the tab, so seeding isn't short-circuited).
 */
export async function createProjectDirectDraft(api: ApiInstance, projectId: string): Promise<Session> {
  const s = await api.createDraftSession({
    target: "direct",
    projectId,
    type: "agent",
    draftConfig: { entryPoint: "tab", channel: "json" },
  });
  useServerStore.getState().applySessionCreated(s);
  return s;
}
