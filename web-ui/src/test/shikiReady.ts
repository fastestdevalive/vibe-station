import { beforeAll } from "vitest";
import { getShikiHighlighter } from "@/components/preview/shikiHighlighter";

/**
 * Load the real Shiki highlighter before a file's tests run.
 *
 * The highlighter is created lazily (`import("shiki")` + `createHighlighter`
 * with 16 grammars) the first time a component highlights something. In a
 * fresh test worker that first import takes ~70 ms on an idle machine but
 * several seconds when the whole suite runs in parallel (measured 8.8 s in the
 * CI image), so the first test asserting on highlighted markup inside a
 * default 1 s `waitFor` failed whenever the machine was busy.
 *
 * Call this at the top level of any test file that asserts on real Shiki
 * output. It waits for the one slow, load-dependent step itself, so the
 * tests' own `waitFor`s only cover what they are about (a re-render with the
 * highlighted HTML), which is fast once the module is in the worker's cache.
 */
export function loadShikiBeforeAll(): void {
  beforeAll(async () => {
    await getShikiHighlighter();
  }, 120_000);
}
