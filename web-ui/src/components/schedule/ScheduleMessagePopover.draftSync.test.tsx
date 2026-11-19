import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { createMockApi } from "@/api/mock";
import { ensureDraftTextSync, scheduleScope } from "@/components/draftsync";
import { engineFor } from "@/components/draftsync/engine";
import { ScheduleMessagePopover } from "./ScheduleMessagePopover";

const engines: ApiInstance[] = [];

function mockApi(): ReturnType<typeof createMockApi> {
  const api = createMockApi();
  engines.push(api);
  return api;
}

/** Ensure the page engine and let its one initial fetch settle. */
async function start(api: ApiInstance): Promise<void> {
  ensureDraftTextSync(api);
  await act(async () => {});
}

function Harness({ api, sessionId }: { api: ApiInstance; sessionId: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button">
        anchor
      </button>
      <ScheduleMessagePopover
        api={api}
        sessionId={sessionId}
        open
        anchorRef={ref}
        targetLabel="Agent 1 · Terminal"
        onClose={() => {}}
      />
    </>
  );
}

const textarea = () => screen.getByLabelText("Message") as HTMLTextAreaElement;

beforeEach(() => {
  localStorage.clear();
  engines.length = 0;
});

afterEach(() => {
  for (const api of engines) engineFor(api)?.stop();
  vi.restoreAllMocks();
});

describe("ScheduleMessagePopover live draft sync (F-05)", () => {
  it("remote_change_lands_in_a_clean_textarea", async () => {
    const api = mockApi();
    await start(api);
    render(<Harness api={api} sessionId="s1" />);
    await screen.findByLabelText("Message");
    expect(textarea().value).toBe("");

    await act(async () => {
      api.__test.emit({
        type: "draft-text:changed",
        scope: scheduleScope("s1"),
        text: "from phone",
        revision: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        clientId: "phone",
      });
    });

    expect(textarea().value).toBe("from phone");
  });

  it("schedule_clears_the_scope", async () => {
    const api = mockApi();
    await start(api);
    const put = vi.spyOn(api, "putDraftText");
    const user = userEvent.setup();
    render(<Harness api={api} sessionId="sess-main" />);

    await user.type(await screen.findByLabelText("Message"), "go");
    // Let the 600 ms debounce sync the typed message first: clearing a scope the
    // server already holds "" for is (correctly) no write at all.
    await waitFor(
      () => expect(put).toHaveBeenCalledWith(scheduleScope("sess-main"), "go", expect.any(String), undefined),
      { timeout: 3000 },
    );

    await user.click(screen.getByRole("button", { name: "Schedule" }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(scheduleScope("sess-main"), "", expect.any(String), undefined),
    );
    expect((await api.getDraftText(scheduleScope("sess-main"))).text).toBe("");
  });
});
