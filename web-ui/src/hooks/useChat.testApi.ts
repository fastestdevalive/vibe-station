import { vi } from "vitest";
import type { BeginEditResponse, NormalizedEvent, SendChatResponse, TranscriptAroundPage, TranscriptPage, TranscriptSincePage, WSEvent } from "@/api/types";

/** Minimal fake api with controllable WS emission for deterministic ordering. */
export function makeApi(sendChatResult: SendChatResponse = { turnId: "t1", queuePosition: 0 }) {
  const listeners = new Map<string, Set<(e: WSEvent) => void>>();
  const emit = (ev: WSEvent) => {
    for (const h of listeners.get("*") ?? []) h(ev);
    for (const h of listeners.get(ev.type) ?? []) h(ev);
  };
  const fake = {
    emit,
    on(type: string, h: (e: WSEvent) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(h);
      return () => listeners.get(type)!.delete(h);
    },
    openChat: vi.fn(async () => {}),
    reopenChat: vi.fn(async () => {}),
    closeChat: vi.fn(async () => {}),
    sendChat: vi.fn(async () => sendChatResult),
    stopChat: vi.fn(async () => ({ ok: true as const })),
    cancelQueuedTurn: vi.fn(async () => ({ ok: true as const })),
    beginEditQueuedTurn: vi.fn(async (_s: string, turnId: string): Promise<BeginEditResponse> => ({
      turnId,
      message: "prefill",
      attachments: [],
      queueIndex: 0,
    })),
    resubmitQueuedTurn: vi.fn(async (_s: string, turnId: string) => ({ ok: true as const, turnId })),
    promoteQueuedTurn: vi.fn(async (_s: string, turnId: string) => ({ ok: true as const, turnId })),
    getTranscriptPage: vi.fn(async (): Promise<TranscriptPage> => ({ events: [], hasMore: false })),
    getTranscriptAll: vi.fn(async () => ({ events: [] as NormalizedEvent[] })),
    getTranscriptSince: vi.fn(async (): Promise<TranscriptSincePage> => ({ events: [], hasMore: false })),
    getTranscriptAround: vi.fn(async (): Promise<TranscriptAroundPage> => ({ events: [], hasMore: false, turnsBefore: 0 })),
  };
  return fake;
}

export function ev(id: string, extra: Partial<NormalizedEvent>): NormalizedEvent {
  return { id, sessionId: "s1", ts: "", provider: "claude", kind: "text", ...extra };
}
