import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { createMockDraftText } from "@/api/mockDraftText";
import { ensureDraftTextSync, pickerScope } from "@/components/draftsync";
import { engineFor } from "@/components/draftsync/engine";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useModesStore } from "@/store/modesStore";
import { ReviewPicker } from "./ReviewPicker";
import { makeApi, makeSession } from "./testHarness";
import { makeComment as c } from "./testFixtures";
import { useCommentStore } from "./useCommentStore";

const SCOPE = pickerScope("worktree:wt-1");
const comments = [c({ id: "a", pin: 1, path: "a.ts" })];

const syncedApis: ApiInstance[] = [];

/** A picker api whose server row already holds `text`, with the page engine
 *  (Decision 9) ensured and its first fetch landed. */
async function syncedApiWith(text: string): Promise<ApiInstance> {
  const api = makeApi({ ...createMockDraftText(() => {}) });
  await api.putDraftText(SCOPE, text, "phone");
  ensureDraftTextSync(api);
  syncedApis.push(api);
  await act(async () => {
    // the engine's one initial fetch
  });
  return api;
}

const anchor = { current: null as HTMLElement | null };

function mount(api: ApiInstance) {
  anchor.current = document.body.appendChild(document.createElement("button"));
  return render(
    <ReviewPicker
      api={api}
      scope={{ scopeKind: "worktree", scopeId: "wt-1" }}
      comments={comments}
      anchorRef={anchor}
      onClose={vi.fn()}
      onDone={vi.fn()}
    />,
  );
}

const primary = () => document.querySelector<HTMLButtonElement>(".comment-picker__primary")!;

beforeEach(() => {
  localStorage.clear();
  useCommentStore.getState().reset();
  useCommentStore.getState().replace("wt-1", "worktree", { comments, nextPin: 2, terminalDeliveries: [] });
  useServerStore.setState({
    sessions: [makeSession({ id: "idle", name: "main", state: "idle" })],
    worktrees: [{ id: "wt-1", projectId: "p1", branch: "feat" }],
  } as never);
  useWorkspaceStore.setState({ sessionStates: {}, activeSessionId: null } as never);
  useModesStore.getState().setModes([{ id: "m-claude", name: "Claude", cli: "claude", context: "" }] as never);
});

afterEach(() => {
  for (const api of syncedApis) engineFor(api)?.stop();
  syncedApis.length = 0;
  anchor.current?.remove();
});

describe("ReviewPicker live draft sync", () => {
  it("message_restored_from_server", async () => {
    const api = await syncedApiWith("restore me");
    mount(api);
    const field = await screen.findByLabelText("Message for the agent");
    await waitFor(() => expect(field.textContent).toContain("restore me"));
  });

  it("send_clears", async () => {
    const api = await syncedApiWith("send this");
    const put = vi.spyOn(api, "putDraftText");
    mount(api);
    await waitFor(() =>
      expect(within(document.querySelector("[role=radio][data-session-id]") as HTMLElement).queryByText("main")).not.toBeNull(),
    );
    fireEvent.click(primary());
    await waitFor(() => expect(api.sendChat).toHaveBeenCalledWith("idle", "send this", undefined, true, undefined, ["a"]));
    await waitFor(() => expect(put).toHaveBeenCalledWith(SCOPE, "", expect.any(String), undefined));
    expect((await api.getDraftText(SCOPE)).text).toBe("");
  });
});
