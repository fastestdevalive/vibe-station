import { vi, type Mock } from "vitest";
import type { ApiInstance } from "@/api";
import type { Session, SupportedCli } from "@/api/types";

/** The recorded calls of a stubbed API method. */
export const calls = (fn: unknown): unknown[][] => (fn as Mock).mock.calls;

/** A spy-able API stub with the methods the tray, list and picker call (override per test). */
export function makeApi(over: Record<string, unknown> = {}): ApiInstance {
  const base: Record<string, unknown> = {
    getConnectionState: () => "online",
    subscribeConnection: () => () => {},
    listComments: vi.fn().mockResolvedValue({ comments: [], nextPin: 1, terminalDeliveries: [] }),
    getSkills: vi.fn().mockResolvedValue({ skills: [] }),
    getSupportedClis: vi.fn().mockResolvedValue([
      { id: "claude", supportsTerminalComments: true } as SupportedCli,
      { id: "plain", supportsTerminalComments: false } as SupportedCli,
    ]),
    listModes: vi.fn().mockResolvedValue([]),
    terminalReadiness: vi.fn().mockResolvedValue("unknown"),
    sendChat: vi.fn().mockResolvedValue({ turnId: "t1", queuePosition: 1 }),
    createTerminalDelivery: vi.fn(),
    cancelTerminalDelivery: vi.fn().mockResolvedValue({ ok: true }),
    renderComments: vi.fn().mockResolvedValue({ text: "RENDERED", bytes: 8, count: 1 }),
    attachComments: vi.fn().mockImplementation(async (_s: string, _k: string, b: { commentIds?: string[] }) => ({ attached: b.commentIds ?? [] })),
    detachComments: vi.fn().mockImplementation(async (_s: string, _k: string, b: { commentIds?: string[] }) => ({ detached: b.commentIds ?? [] })),
    dismissRestoredComments: vi.fn().mockResolvedValue({ cleared: 1 }),
    scheduleMessage: vi.fn().mockResolvedValue({ id: "sch1", fireAt: "2099-01-01T00:00:00Z" }),
    createDraftSession: vi.fn(),
    updateDraft: vi.fn().mockResolvedValue({ ok: true, name: null }),
    restoreReview: vi.fn(),
    on: () => () => {},
    ...over,
  };
  return base as never;
}

export function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    worktreeId: "wt-1",
    projectId: "p1",
    modeId: "m-claude",
    type: "agent",
    name: "main",
    isMain: true,
    state: "idle",
    lifecycleState: "drafting",
    tmuxName: "t",
    channel: "json",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  } as Session;
}
