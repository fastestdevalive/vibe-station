import type { ApiInstance } from "@/api";
import type { OutlineSummaryState } from "@/hooks/useTranscriptOutline";
import type { OutlineWindows } from "@/hooks/useOutlineWindows";
import { groupEvents, type RenderItem } from "../MessageList";

/** Turns of the window fetched for beats: the one around the marked turn. */
export const BEAT_WINDOW_TURNS = 15;

/** The render items of a window fetched for beats, with its own seq index. */
export interface BeatWindowItems {
  items: RenderItem[];
  seqIndex: Map<number, string>;
  turnsBefore: number;
}

/** Whole-chat summary plus the loaders the outline needs; the event window itself stays in `useChat`. */
export interface OutlineSource {
  /** Fixed-size bucketed counts; whole-chat mode only while `status === "ready"`. */
  summary: OutlineSummaryState;
  /** Per-turn labels/counts by index, fetched on demand (owner: `useOutlineWindows`). */
  windows: OutlineWindows;
  viewAround: (seq: number) => Promise<void>;
  /** A loaded turn disagrees with its cached window turn: the owner refetches the summary. */
  onMismatch: () => void;
  fetchWindow: (seq: number, signal: AbortSignal) => Promise<BeatWindowItems>;
}

/** Fetches the window around `seq` and groups it into render items, for beats only. */
export function createFetchWindow(api: ApiInstance, sessionId: string): OutlineSource["fetchWindow"] {
  return async (seq, signal) => {
    const page = await api.getTranscriptAround(sessionId, seq, { limit: BEAT_WINDOW_TURNS, signal });
    const seqIndex = new Map<number, string>();
    const items = groupEvents(page.events, seqIndex);
    return { items, seqIndex, turnsBefore: page.turnsBefore };
  };
}
