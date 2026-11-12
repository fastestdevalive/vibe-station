import { ApiError } from "./errors";
import { findTerms, locate, eventFindText } from "@/lib/findTerms";
import type {
  NormalizedEvent,
  SnippetSegment,
  TranscriptAroundPage,
  TranscriptSincePage,
  TranscriptSearchMatch,
  TranscriptSearchPage,
  TranscriptSearchScope,
} from "./types";

export interface MockSearchParams {
  q: string;
  scope?: TranscriptSearchScope;
  after?: string;
  limit?: number;
  snippets?: "0" | "1" | boolean;
}

export function mockSearchTranscript(
  allEvents: readonly NormalizedEvent[],
  params: MockSearchParams,
): TranscriptSearchPage {
  const q = params.q.trim();
  if (!q || q.length > 200) {
    throw new ApiError("invalid query", 400, "QUERY_INVALID");
  }
  const terms = findTerms(q);
  if (terms.length === 0) {
    throw new ApiError("invalid query", 400, "QUERY_INVALID");
  }

  const scope = params.scope ?? "messages";
  const limit = params.limit ?? 1000;
  const wantSnippets = params.snippets === "1" || params.snippets === true;

  interface SearchDoc {
    seq: number;
    turnId?: string;
    turnIndex: number;
    kind: "user" | "text" | "thinking" | "tool_use" | "tool_result";
    text: string;
    ts?: string;
  }
  const docs: SearchDoc[] = [];
  let turnCounter = 0;
  const turnIndexByTurnKey = new Map<string, number>();

  for (const ev of allEvents) {
    if (!ev.superseded && !ev.silent && ev.kind === "user") {
      const key = ev.turnId ?? `seq:${ev.logSeq ?? ev.id}`;
      if (!turnIndexByTurnKey.has(key)) {
        turnCounter++;
        turnIndexByTurnKey.set(key, turnCounter);
      }
    }
  }
  const totalTurnCount = turnCounter;

  let currentRun: {
    seq: number;
    kind: "text" | "thinking";
    turnId?: string;
    texts: string[];
    ts?: string;
  } | null = null;

  function flushRun() {
    if (!currentRun) return;
    const turnKey = currentRun.turnId;
    const tIdx = turnKey ? (turnIndexByTurnKey.get(turnKey) ?? 0) : 0;
    docs.push({
      seq: currentRun.seq,
      turnId: currentRun.turnId,
      turnIndex: tIdx,
      kind: currentRun.kind,
      text: currentRun.texts.join(""),
      ts: currentRun.ts,
    });
    currentRun = null;
  }

  for (const ev of allEvents) {
    const findInfo = eventFindText(ev);
    if (!findInfo) {
      flushRun();
      continue;
    }

    const seq = ev.logSeq ?? 0;
    const turnKey = ev.turnId ?? (ev.kind === "user" ? `seq:${ev.logSeq ?? ev.id}` : undefined);
    const tIdx = turnKey ? (turnIndexByTurnKey.get(turnKey) ?? 0) : 0;

    if (findInfo.kind === "text" || findInfo.kind === "thinking") {
      if (
        currentRun &&
        currentRun.kind === findInfo.kind &&
        currentRun.turnId === ev.turnId
      ) {
        currentRun.texts.push(findInfo.text);
      } else {
        flushRun();
        currentRun = {
          seq,
          kind: findInfo.kind,
          turnId: ev.turnId,
          texts: [findInfo.text],
          ts: ev.ts,
        };
      }
    } else {
      flushRun();
      docs.push({
        seq,
        turnId: ev.turnId,
        turnIndex: tIdx,
        kind: findInfo.kind,
        text: findInfo.text,
        ts: ev.ts,
      });
    }
  }
  flushRun();

  let afterSeq = -1;
  let afterOcc = -1;
  if (params.after) {
    const parts = params.after.split(":");
    if (parts.length === 2) {
      afterSeq = Number(parts[0]);
      afterOcc = Number(parts[1]);
    }
  }

  const allMatches: TranscriptSearchMatch[] = [];
  for (const doc of docs) {
    if (scope === "messages" && doc.kind !== "user" && doc.kind !== "text") {
      continue;
    }
    const ranges = locate(doc.text, terms);
    for (let occ = 0; occ < ranges.length; occ++) {
      if (doc.seq < afterSeq || (doc.seq === afterSeq && occ <= afterOcc)) {
        continue;
      }
      const range = ranges[occ]!;
      let snippet: SnippetSegment[] | undefined;
      if (wantSnippets) {
        const hitStart = range[0];
        const hitEnd = range[1];
        const contextStart = Math.max(0, hitStart - 60);
        const contextEnd = Math.min(doc.text.length, hitEnd + 60);
        const beforeText = doc.text.slice(contextStart, hitStart).replace(/\s+/g, " ");
        const hitText = doc.text.slice(hitStart, hitEnd).replace(/\s+/g, " ");
        const afterText = doc.text.slice(hitEnd, contextEnd).replace(/\s+/g, " ");
        snippet = [
          { text: beforeText },
          { text: hitText, hit: true },
          { text: afterText },
        ];
      }
      allMatches.push({
        seq: doc.seq,
        turnId: doc.turnId,
        turnIndex: doc.turnIndex,
        kind: doc.kind,
        occurrence: occ,
        ts: doc.ts,
        ...(snippet ? { snippet } : {}),
      });
    }
  }

  const total = allMatches.length;
  const totalCapped = total > 1000;
  const pageMatches = allMatches.slice(0, limit);
  const nextCursor =
    total > pageMatches.length && pageMatches.length > 0
      ? `${pageMatches[pageMatches.length - 1]!.seq}:${pageMatches[pageMatches.length - 1]!.occurrence}`
      : undefined;

  const newestSeq = allEvents.length ? allEvents[allEvents.length - 1]!.logSeq : undefined;

  return {
    query: q,
    total: Math.min(total, 1000),
    totalCapped,
    matches: pageMatches,
    nextCursor,
    indexedThroughSeq: newestSeq,
    backfilling: false,
    turnCount: totalTurnCount,
  };
}

export function mockGetTranscriptAround(
  allEvents: readonly NormalizedEvent[],
  aroundSeq: number,
): TranscriptAroundPage {
  const limit = 15;
  if (!allEvents.length) {
    return {
      events: [],
      hasMore: false,
      turnsBefore: 0,
    };
  }

  const turns: NormalizedEvent[][] = [];
  let currentTurn: NormalizedEvent[] = [];
  let currentTurnId: string | undefined = undefined;

  for (const ev of allEvents) {
    if (ev.turnId && ev.turnId !== currentTurnId) {
      if (currentTurn.length) turns.push(currentTurn);
      currentTurn = [ev];
      currentTurnId = ev.turnId;
    } else {
      currentTurn.push(ev);
    }
  }
  if (currentTurn.length) turns.push(currentTurn);

  let targetTurnIdx = turns.findIndex((t) =>
    t.some((ev) => ev.logSeq === aroundSeq),
  );
  if (targetTurnIdx === -1) {
    targetTurnIdx = turns.length - 1;
  }

  const half = Math.floor((limit - 1) / 2);
  const startTurnIdx = Math.max(0, targetTurnIdx - half);
  const endTurnIdx = Math.min(turns.length, startTurnIdx + limit);
  const selectedTurns = turns.slice(startTurnIdx, endTurnIdx);
  const events = selectedTurns.flat();

  const oldestSeq = events.length ? events[0]!.logSeq : undefined;

  let turnsBefore = 0;
  if (oldestSeq != null) {
    const seenTurns = new Set<string>();
    for (const ev of allEvents) {
      if ((ev.logSeq ?? 0) < oldestSeq && !ev.superseded && !ev.silent && ev.kind === "user") {
        const key = ev.turnId ?? `seq:${ev.logSeq ?? ev.id}`;
        if (!seenTurns.has(key)) {
          seenTurns.add(key);
          turnsBefore++;
        }
      }
    }
  }

  return {
    events: structuredClone(events),
    oldestSeq,
    hasMore: startTurnIdx > 0,
    turnsBefore,
  };
}

/** Rows per `since` page, the daemon's `SINCE_PAGE_SIZE`. */
export const MOCK_SINCE_PAGE_SIZE = 200;

/** Mirror of the daemon's `since` reader: rows strictly newer than `sinceSeq`. */
export function mockGetTranscriptSince(
  allEvents: readonly NormalizedEvent[],
  sinceSeq: number,
): TranscriptSincePage {
  const newer = allEvents.filter((e) => !e.superseded && (e.logSeq ?? -1) > sinceSeq);
  const page = newer.slice(0, MOCK_SINCE_PAGE_SIZE);
  const last = page[page.length - 1]?.logSeq;
  return {
    events: structuredClone(page),
    ...(last != null ? { nextSeq: last } : {}),
    hasMore: page.length < newer.length,
  };
}
