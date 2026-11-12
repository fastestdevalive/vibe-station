import {
  bucketSizeFor,
  outlineTurnsFromEvents,
} from "@/lib/transcriptOutline";
import { ApiError } from "./errors";
import type { NormalizedEvent, TranscriptOutlineSummary, TranscriptOutlineWindow } from "./types";

const WINDOW_DEFAULT = 40;
const WINDOW_MAX = 100;

/** Mock of `GET /sessions/:id/transcript/outline`: the same bucket rule and counts as the daemon. */
export function mockTranscriptOutline(allEvents: readonly NormalizedEvent[]): TranscriptOutlineSummary {
  const turns = outlineTurnsFromEvents(allEvents);
  const bucketSize = bucketSizeFor(turns.length);
  const buckets = Math.ceil(turns.length / bucketSize);
  const tools = new Array<number>(buckets).fill(0);
  const edits = new Array<number>(buckets).fill(0);
  const errors = new Array<number>(buckets).fill(0);
  turns.forEach((turn, index) => {
    const b = Math.floor(index / bucketSize);
    tools[b]! += turn.counts.tools;
    edits[b]! += turn.counts.edits;
    errors[b]! += turn.counts.errors;
  });
  return { ready: true, totalTurns: turns.length, revision: "0", bucketSize, tools, edits, errors };
}

/** Mock of `GET /sessions/:id/transcript/outline/window`: turns `from..from+limit` of the same skeleton. */
export function mockTranscriptOutlineWindow(
  allEvents: readonly NormalizedEvent[],
  params: { from: number; limit?: number },
): TranscriptOutlineWindow {
  const limit = params.limit ?? WINDOW_DEFAULT;
  if (!Number.isInteger(params.from) || params.from < 0 || !Number.isInteger(limit) || limit < 1 || limit > WINDOW_MAX) {
    throw new ApiError("invalid query", 400, "INVALID_QUERY");
  }
  const turns = outlineTurnsFromEvents(allEvents);
  return {
    ready: true,
    totalTurns: turns.length,
    revision: "0",
    from: params.from,
    turns: turns.slice(params.from, params.from + limit),
  };
}
