import { useEffect, useMemo, useRef, useState } from "react";
import type { GrammarState } from "shiki";
import { highlightChunk } from "./shikiHighlighter";

/** Lines tokenized per chunk of the sequential pass. */
export const CHUNK_LINES = 500;

async function yieldToMain(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof sched?.yield === "function") {
    // Must be called as a method, not destructured (destructuring throws
    // "Illegal invocation").
    await sched.yield();
  } else {
    await new Promise((r) => setTimeout(r, 0));
  }
}

export interface UseChunkedHighlightOptions {
  code: string;
  lang: string;
  themeId: string;
  enabled: boolean;
  /** 0-indexed `[startLine, endLine]` inclusive range currently visible. */
  visibleRange: [number, number] | null;
}

type ChunkState = { lines: string[]; exact: boolean };
interface ChunkIdentity {
  code: string;
  lang: string;
  themeId: string;
}
function sameIdentity(a: ChunkIdentity, b: ChunkIdentity): boolean {
  return a.code === b.code && a.lang === b.lang && a.themeId === b.themeId;
}
const EMPTY_CHUNKS: Map<number, ChunkState> = new Map();

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Incremental, time-sliced, state-carrying syntax highlighting for large
 * files (Decision 12). Files are tokenized in `CHUNK_LINES`-sized chunks, one
 * chunk per event-loop turn, carrying the tokenizer's `grammarState` forward so
 * multi-line constructs stay exact across chunk boundaries.
 *
 * A far jump/scroll into a chunk the sequential pass hasn't reached yet is
 * highlighted immediately (approximate — no carried state) and refined later
 * when the sequential pass arrives, only if the HTML differs.
 *
 * Returns one HTML string per line, `undefined` for lines whose chunk has not
 * been started yet (the caller falls back to `escapeHtml(line)` for those).
 */
export function useChunkedHighlight({
  code,
  lang,
  themeId,
  enabled,
  visibleRange,
}: UseChunkedHighlightOptions): (string | undefined)[] {
  // Field-wise compare (same `code` string reference short-circuits) — a joined
  // template string would cost O(file size) on every render.
  const identity: ChunkIdentity = { code, lang, themeId };
  // Chunks are tagged with the identity they were computed for so a content
  // change never renders one frame of the previous file's highlighting.
  const [chunkState, setChunks_] = useState<{ identity: ChunkIdentity; map: Map<number, ChunkState> }>({
    identity,
    map: new Map(),
  });
  const chunks = sameIdentity(chunkState.identity, identity) ? chunkState.map : EMPTY_CHUNKS;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const chunksRef = useRef(chunks);
  chunksRef.current = chunks;
  const setChunks = (fn: (prev: Map<number, ChunkState>) => Map<number, ChunkState>) =>
    setChunks_((cur) => {
      const base = sameIdentity(cur.identity, identityRef.current) ? cur.map : new Map<number, ChunkState>();
      const map = fn(base);
      return map === cur.map && sameIdentity(cur.identity, identityRef.current)
        ? cur
        : { identity: identityRef.current, map };
    });
  const genRef = useRef(0);

  const lines = useMemo(() => (code.length === 0 ? [] : code.split("\n")), [code]);
  const chunkCount = Math.ceil(lines.length / CHUNK_LINES);

  // Increment the generation counter on any identity change and clear the
  // whole map so a stale pass can never publish into a fresh file's state.
  useEffect(() => {
    genRef.current++;
  }, [code, lang, themeId]);

  // Run the sequential exact pass while enabled. Cancelled (via the generation
  // counter) whenever `code`/`lang`/`themeId` changes — checked before every
  // chunk and after every yield.
  useEffect(() => {
    if (!enabled) return;
    const gen = ++genRef.current;
    let cancelled = false;

    void (async () => {
      let state: GrammarState | undefined;
      for (let c = 0; c < chunkCount; c++) {
        if (cancelled || gen !== genRef.current) return;
        const chunkLines = lines.slice(c * CHUNK_LINES, (c + 1) * CHUNK_LINES).join("\n");
        const result = await highlightChunk(chunkLines, lang, themeId, state);
        if (cancelled || gen !== genRef.current) return;
        state = result.endState;
        setChunks((prev) => {
          const existing = prev.get(c);
          // Never replace an exact chunk with an approximate one.
          if (existing?.exact) return prev;
          // Identical HTML to the approximate pass: just flip the flag in
          // place (same array) rather than forcing a visible change.
          const next = new Map(prev);
          next.set(c, {
            lines: existing && sameLines(existing.lines, result.lines) ? existing.lines : result.lines,
            exact: true,
          });
          return next;
        });
        await yieldToMain();
        if (cancelled || gen !== genRef.current) return;
      }
    })();

    return () => {
      cancelled = true;
    };
    // `lines`/`chunkCount` derive from `code`; `code` is the identity dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, code, lang, themeId, chunkCount]);

  // Approximate immediate highlight for the visible range, for any chunk the
  // sequential pass hasn't reached. Must NOT feed its end state into the
  // sequential pass's carried state — approximate state is invalid. Check the
  // generation counter after every await. Depends only on the (stable) chunk
  // index signature, so scrolling within the same chunks does not re-run it.
  const [vs, ve] = visibleRange ?? [0, -1];
  const visibleStartChunk = visibleRange ? Math.floor(vs / CHUNK_LINES) : -1;
  const visibleEndChunk = visibleRange ? Math.floor(ve / CHUNK_LINES) : -1;
  useEffect(() => {
    if (!enabled || !visibleRange || visibleEndChunk < visibleStartChunk) return;
    const gen = genRef.current;

    void (async () => {
      for (let c = visibleStartChunk; c <= visibleEndChunk; c++) {
        if (gen !== genRef.current) return;
        const chunkLines = lines.slice(c * CHUNK_LINES, (c + 1) * CHUNK_LINES).join("\n");
        if (chunkLines.length === 0) continue;
        // Already highlighted (exact or approximate): nothing to do.
        if (chunksRef.current.has(c)) continue;
        // Approximate: no grammarState (an in-progress block comment can't be
        // known to start at the chunk boundary).
        const result = await highlightChunk(chunkLines, lang, themeId, undefined);
        if (gen !== genRef.current) return;
        setChunks((prev) => {
          const existing = prev.get(c);
          // Never replace an exact (or already-approximated) chunk.
          if (existing?.exact) return prev;
          const next = new Map(prev);
          next.set(c, { lines: result.lines, exact: false });
          return next;
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, code, lang, themeId, visibleStartChunk, visibleEndChunk]);

  return useMemo(() => {
    const out: (string | undefined)[] = new Array(lines.length).fill(undefined);
    for (const [c, chunk] of chunks) {
      const startLine = c * CHUNK_LINES;
      for (let i = 0; i < chunk.lines.length; i++) {
        out[startLine + i] = chunk.lines[i];
      }
    }
    return out;
  }, [lines, chunks]);
}
