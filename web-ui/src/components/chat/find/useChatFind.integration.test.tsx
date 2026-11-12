import { useRef } from "react";
import { render, screen, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import type { ApiInstance } from "@/api";
import type { NormalizedEvent, TranscriptAroundPage, TranscriptPage, WSEvent } from "@/api/types";
import { useChat } from "@/hooks/useChat";
import * as chatSnapshotCache from "@/hooks/chatSnapshotCache";
import { MessageList } from "../MessageList";
import type { MessageNav } from "../messageNav";
import { useChatFind } from "./useChatFind";

/** Minimal fake api (the `useChat` test double pattern) with WS emission. */
function makeApi() {
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
    closeChat: vi.fn(async () => {}),
    getTranscriptPage: vi.fn(async (): Promise<TranscriptPage> => ({ events: [], hasMore: false })),
    getTranscriptAll: vi.fn(async () => ({ events: [] as NormalizedEvent[] })),
    getTranscriptAround: vi.fn(async (): Promise<TranscriptAroundPage> => ({
      events: [] as NormalizedEvent[],
      hasMore: false,
      turnsBefore: 0,
    })),
    searchTranscript: vi.fn(),
  };
  return fake;
}

function ev(id: string, extra: Partial<NormalizedEvent>): NormalizedEvent {
  return { id, sessionId: "s1", ts: "", provider: "claude", kind: "text", ...extra };
}

function Harness({
  api,
  onReady,
}: {
  api: ReturnType<typeof makeApi>;
  onReady: (find: ReturnType<typeof useChatFind>) => void;
}) {
  const navRef = useRef<MessageNav | null>(null);
  const chat = useChat(api as unknown as ApiInstance, "s1", true);
  const find = useChatFind({
    sessionId: "s1",
    api: api as unknown as ApiInstance,
    events: chat.events,
    navRef,
    onLoadEarlierTo: chat.loadEarlierTo,
    onViewAround: chat.viewAround,
  });
  onReady(find);
  return (
    <div className="chat-pane__body">
      <MessageList
        events={chat.events}
        pending={[]}
        hasMore={chat.hasMore}
        loadingEarlier={chat.loadingEarlier}
        onLoadEarlier={chat.loadEarlier}
        navRef={navRef}
      />
    </div>
  );
}

beforeEach(() => {
  chatSnapshotCache.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useChatFind — jump to a not-loaded match lands after the window commit", () => {
  it("loads the rows, then scrolls the NEW anchor once MessageList has re-derived nav", async () => {
    const api = makeApi();
    const findRef: { current: ReturnType<typeof useChatFind> | null } = { current: null };

    render(<Harness api={api} onReady={(f) => (findRef.current = f)} />);

    // Bounded tail: only seq 500 is loaded; older rows exist.
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [
          ev("e500", { kind: "user", role: "user", text: "recent", turnId: "t500", logSeq: 500 }),
        ],
        oldestSeq: 500,
        hasMore: true,
        turnsBefore: 12,
      });
    });
    await screen.findByText("recent");

    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");

    // A find hit 100 rows above the window → one keyset page.
    api.getTranscriptPage.mockResolvedValueOnce({
      events: [
        ev("e400", { kind: "user", role: "user", text: "target", turnId: "t400", logSeq: 400 }),
      ],
      oldestSeq: 400,
      hasMore: true,
      turnsBefore: 10,
    });

    act(() => {
      findRef.current!.openFind();
    });

    await act(async () => {
      await findRef.current!.jumpTo({ seq: 400, occurrence: 0, turnIndex: 2, kind: "user" });
    });

    expect(await screen.findByText("target")).toBeTruthy();
    const row = document.querySelector('[data-find-anchor="u:t400"]');
    expect(row).not.toBeNull();
    // The scroll must land on the NEW row (the old nav could not resolve seq 400).
    expect(
      scrollSpy.mock.instances.some((instance) => instance === row),
    ).toBe(true);
  });
});
