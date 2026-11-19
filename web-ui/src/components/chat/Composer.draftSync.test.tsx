import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { createMockApi } from "@/api/mock";
import { ensureDraftTextSync } from "@/components/draftsync";
import { engineFor } from "@/components/draftsync/engine";
import { Composer } from "./Composer";

const apis: ApiInstance[] = [];

function mockApi() {
  const api = createMockApi();
  apis.push(api);
  return api;
}

async function start(api: ApiInstance): Promise<void> {
  ensureDraftTextSync(api);
  await act(async () => {
    // the engine's one initial fetch
  });
}

function changed(api: ReturnType<typeof createMockApi>, scope: string, text: string, revision: number, clientId = "phone") {
  return act(async () => {
    api.__test.emit({
      type: "draft-text:changed",
      scope,
      text,
      revision,
      updatedAt: "2026-01-01T00:00:00.000Z",
      clientId,
    });
  });
}

beforeEach(() => {
  localStorage.clear();
  apis.length = 0;
});

afterEach(() => {
  for (const api of apis) engineFor(api)?.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Composer live draft sync", () => {
  it("seeds_from_server_doc", async () => {
    const api = mockApi();
    await api.putDraftText("s1", "server draft", "phone");
    await start(api);
    render(<Composer api={api} sessionId="s1" onSend={vi.fn()} />);
    expect(screen.getByLabelText("Message").textContent).toBe("server draft");
  });

  it("remote_text_appears_when_clean", async () => {
    const api = mockApi();
    await start(api);
    render(<Composer api={api} sessionId="s1" onSend={vi.fn()} />);
    await changed(api, "s1", "from phone", 1);
    expect(screen.getByLabelText("Message").textContent).toBe("from phone");
  });

  it("remote_does_not_overwrite_while_typing", async () => {
    const api = mockApi();
    await start(api);
    render(
      <Composer
        api={api}
        sessionId="s1"
        onSend={vi.fn()}
        initialText="{/code-review}"
        commands={[{ name: "code-review", description: "Review" }]}
      />,
    );
    const input = screen.getByLabelText("Arguments for code-review") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "high" } });
    });
    await changed(api, "s1", "from phone", 1);
    expect((screen.getByLabelText("Arguments for code-review") as HTMLInputElement).value).toBe("high");
    expect(screen.getByLabelText("Message").textContent).not.toContain("from phone");
  });

  it("remote_apply_does_not_put", async () => {
    const api = mockApi();
    await start(api);
    const put = vi.spyOn(api, "putDraftText");
    render(<Composer api={api} sessionId="s1" onSend={vi.fn()} />);
    await changed(api, "s1", "from phone", 1);
    expect(screen.getByLabelText("Message").textContent).toBe("from phone");
    expect(put).not.toHaveBeenCalled();
  });

  it("send_clears_server_draft_and_other_client_empties", async () => {
    const api = mockApi();
    await api.putDraftText("s1", "hello", "phone");
    await start(api);
    const put = vi.spyOn(api, "putDraftText");
    const onSend = vi.fn<(m: string, ids: string[]) => Promise<void>>(() => Promise.resolve());
    render(
      <>
        <Composer api={api} sessionId="s1" onSend={onSend} />
        <Composer api={api} sessionId="s1" onSend={vi.fn()} />
      </>,
    );
    const before = screen.getAllByLabelText("Message");
    expect(before.map((e) => e.textContent)).toEqual(["hello", "hello"]);

    await act(async () => {
      fireEvent.click(screen.getAllByLabelText("Send message")[0]!);
    });
    await waitFor(() => expect(put).toHaveBeenCalledWith("s1", "", expect.any(String), undefined));
    expect(onSend).toHaveBeenCalledWith("hello", []);
    expect(screen.getAllByLabelText("Message").map((e) => e.textContent)).toEqual(["", ""]);
  });
});
