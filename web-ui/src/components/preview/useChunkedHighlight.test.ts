import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChunkedHighlight, CHUNK_LINES } from "./useChunkedHighlight";
import * as shiki from "./shikiHighlighter";
import type { GrammarState } from "shiki";

const FIXTURE = `function foo() {
  /* block
   * comment
   * spanning
   * lines */
  const s = \`template
  literal\`;
  return s;
}`;

// ── Mock ─────────────────────────────────────────────────────────────────
// Mock only `highlightChunk` (everything else stays real). 3.T8 delegates to
// the real implementation; 3.T9 uses a deferred queue so we can resolve each
// chunk call in a precise order.
vi.mock("./shikiHighlighter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shikiHighlighter")>();
  return {
    ...actual,
    // Default implementation delegates to the real `highlightChunk` (used by
    // 3.T8); 3.T9 overrides it with a deferred queue in `beforeEach`.
    highlightChunk: vi.fn(actual.highlightChunk),
  };
});

const mockHC = vi.mocked(shiki.highlightChunk);

type Deferred = { resolve: (v: { lines: string[]; endState: GrammarState | undefined }) => void };
let deferreds: Deferred[] = [];

function makeCode(totalLines: number): string {
  return Array.from({ length: totalLines }, (_, i) => `line ${i}`).join("\n");
}
function chunkHtml(chunkIdx: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `<span>c${chunkIdx}-l${i}</span>`);
}

describe("highlightChunk equivalence (3.T8)", () => {
  beforeAll(async () => {
    await shiki.setActiveTheme("github-dark");
  });

  it("chained 3-line chunks (carried grammarState) equal whole-document highlight", async () => {
    const whole = await shiki.highlightDocumentLines(FIXTURE, "javascript", "github-dark");
    const lines = FIXTURE.split("\n");
    const joined: string[] = [];
    let state: GrammarState | undefined = undefined;
    for (let c = 0; c < lines.length; c += 3) {
      const chunk = lines.slice(c, c + 3).join("\n");
      // The mock's default implementation is the real `highlightChunk`.
      const res = await shiki.highlightChunk(chunk, "javascript", "github-dark", state);
      state = res.endState;
      joined.push(...res.lines);
    }
    expect(joined).toEqual(whole);
  });
});

describe("useChunkedHighlight (3.T9)", () => {
  beforeEach(() => {
    deferreds = [];
    mockHC.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferreds.push({ resolve });
        }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function resolveDeferred(index: number, chunkIdx: number, count: number, endState?: GrammarState) {
    const d = deferreds[index];
    if (!d) throw new Error(`no deferred at ${index}`);
    d.resolve({ lines: chunkHtml(chunkIdx, count), endState });
  }

  it("discards stale chunks when code changes mid-pass", async () => {
    vi.useFakeTimers();
    const code1 = makeCode(CHUNK_LINES * 2); // 2 chunks
    const code2 = makeCode(CHUNK_LINES); // 1 chunk (different identity)

    const { rerender, result } = renderHook(
      ({ code }) =>
        useChunkedHighlight({
          code,
          lang: "javascript",
          themeId: "github-dark",
          enabled: true,
          visibleRange: null,
        }),
      { initialProps: { code: code1 } },
    );

    // Sequential pass for code1: chunk 0 request is queued.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Resolve chunk 0 → published.
    resolveDeferred(0, 0, CHUNK_LINES, "state-0" as unknown as GrammarState);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current[0]).toBe("<span>c0-l0</span>");

    // Change code mid-pass; the generation bumps and the map clears.
    rerender({ code: code2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current[0]).not.toBe("<span>c0-l0</span>");

    // Now resolve the old pass's chunk 1 (stale). It must be dropped.
    // (Sequential chunk 1 of code1 is the 2nd call.)
    resolveDeferred(1, 1, CHUNK_LINES, "state-1" as unknown as GrammarState);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current[CHUNK_LINES]).not.toBe("<span>c1-l0</span>");
  });

  it("highlights an unreached chunk approximately, then refines it when the sequential pass arrives", async () => {
    vi.useFakeTimers();
    const code = makeCode(CHUNK_LINES * 3); // 3 chunks

    const { result } = renderHook(() =>
      useChunkedHighlight({
        code,
        lang: "javascript",
        themeId: "github-dark",
        enabled: true,
        visibleRange: [2 * CHUNK_LINES, 2 * CHUNK_LINES + 10],
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Sequential effect (declared first) queues chunk 0 (deferreds[0]).
    // Approximate effect queues visible chunk 2 (deferreds[1]).

    // Resolve approximate chunk 2 (no carried state) → published approximate.
    resolveDeferred(1, 2, CHUNK_LINES);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current[2 * CHUNK_LINES]).toBe("<span>c2-l0</span>");

    // Resolve sequential chunk 0 exact.
    resolveDeferred(0, 0, CHUNK_LINES, "state-0" as unknown as GrammarState);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Sequential now queues chunk 1 (deferreds[2]).
    resolveDeferred(2, 1, CHUNK_LINES, "state-1" as unknown as GrammarState);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Sequential now queues chunk 2 (deferreds[3]) — resolve it exact with a
    // DIFFERENT html than the approximation, so replacement is observable.
    const d3 = deferreds[3];
    if (!d3) throw new Error("no deferred at 3");
    d3.resolve({ lines: chunkHtml(2, CHUNK_LINES).map((s) => s.replace("c2-l", "c2-exact-")), endState: "state-2" as unknown as GrammarState });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Approximate chunk 2 was replaced by the exact sequential pass result.
    expect(result.current[2 * CHUNK_LINES]).toBe("<span>c2-exact-0</span>");
  });
});
