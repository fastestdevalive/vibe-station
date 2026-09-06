import { describe, it, expect } from "vitest";
import { createMockApi } from "@/api/mock";
import { createSessionRepository } from "./sessionRepository";

describe("createSessionRepository", () => {
  it("forwards every method by identity — no new logic introduced", () => {
    const api = createMockApi();
    const repo = createSessionRepository(api);
    const methods = [
      "listSessions",
      "createSession",
      "createDirectSession",
      "nextTerminalName",
      "pinSession",
      "renameSession",
      "reorderSession",
      "resetSession",
      "handoffSession",
      "markSessionDone",
      "terminateSession",
      "resumeSession",
      "delinkSession",
      "openSession",
      "closeSession",
      "sendKeystroke",
      "sendDebug",
      "resizeSession",
      "getMeta",
      "on",
    ] as const;
    for (const method of methods) {
      expect(repo[method]).toBe(api[method]);
    }
  });

  it("listSessions returns the underlying api's sessions for a worktree", async () => {
    const api = createMockApi();
    const repo = createSessionRepository(api);
    const [wt] = await api.listWorktrees("proj-a");
    const viaRepo = await repo.listSessions(wt!.id);
    const viaApi = await api.listSessions(wt!.id);
    expect(viaRepo).toEqual(viaApi);
  });

  it("on() is the same multiplexed dispatcher as api.on() — registering via the repo is registering on api", () => {
    const api = createMockApi();
    const repo = createSessionRepository(api);
    const off = repo.on("session:created", () => {});
    // If repo.on were a different function, this would throw or no-op silently.
    // Identity (asserted above) already guarantees this, but exercise the
    // call shape too so a future refactor that breaks the reference is caught.
    expect(typeof off).toBe("function");
    off();
  });
});
