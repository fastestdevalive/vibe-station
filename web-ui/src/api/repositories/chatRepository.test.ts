import { describe, it, expect, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { createChatRepository } from "./chatRepository";

describe("createChatRepository", () => {
  it("forwards every method by identity — no new logic introduced", () => {
    const api = createMockApi();
    const repo = createChatRepository(api);
    const methods = [
      "openChat",
      "closeChat",
      "sendChat",
      "stopChat",
      "cancelQueuedTurn",
      "beginEditQueuedTurn",
      "resubmitQueuedTurn",
      "promoteQueuedTurn",
      "forkChat",
      "setSessionModel",
      "setSessionChannel",
      "uploadAttachments",
      "deleteAttachment",
      "getTranscript",
      "getTranscriptPage",
      "getTranscriptAll",
      "on",
    ] as const;
    for (const method of methods) {
      expect(repo[method]).toBe(api[method]);
    }
  });

  it("sendChat behaves identically via the repo and the raw api", async () => {
    const api = createMockApi();
    const repo = createChatRepository(api);
    const viaRepo = await repo.sendChat("sess-main", "hello");
    expect(viaRepo).toMatchObject({ turnId: expect.any(String), queuePosition: 0 });
    const viaApi = await api.sendChat("sess-main", "hello again");
    expect(viaApi).toMatchObject({ turnId: expect.any(String), queuePosition: 0 });
  });

  it("stopChat forwards sessionId and optional turnId to api", async () => {
    const api = createMockApi();
    const stopSpy = vi.spyOn(api, "stopChat");
    const repo = createChatRepository(api);
    await repo.stopChat("sess-1", "turn-123");
    expect(stopSpy).toHaveBeenCalledWith("sess-1", "turn-123");
    await repo.stopChat("sess-2");
    expect(stopSpy).toHaveBeenCalledWith("sess-2");
  });
});
