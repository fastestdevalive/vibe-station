export interface QuoteHit {
  /** Offset of the match in the corpus. */
  start: number;
  end: number;
}

export interface QuoteLocator {
  quote: string;
  prefix: string;
  suffix: string;
  occurrence: number;
}

/** Length of the common tail of `a` and `b` (how well the text before a match agrees with the stored prefix). */
function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/**
 * Find a stored quote in `corpus`: every occurrence is scored by how much of its surrounding text agrees with
 * the stored `(prefix, suffix)`; the best wins, ties go to the stored `occurrence` index among the ties' order.
 * No fuzzy matching (v1): a quote that is not found verbatim returns null, which the UI shows as outdated.
 */
export function locateQuote(corpus: string, q: QuoteLocator): QuoteHit | null {
  if (!q.quote) return null;
  const hits: number[] = [];
  for (let i = corpus.indexOf(q.quote); i !== -1; i = corpus.indexOf(q.quote, i + q.quote.length)) hits.push(i);
  if (hits.length === 0) return null;
  if (hits.length === 1) return { start: hits[0]!, end: hits[0]! + q.quote.length };
  const scored = hits.map((at, idx) => ({
    at,
    idx,
    score:
      commonSuffix(corpus.slice(Math.max(0, at - q.prefix.length), at), q.prefix) +
      commonPrefix(corpus.slice(at + q.quote.length, at + q.quote.length + q.suffix.length), q.suffix),
  }));
  const best = Math.max(...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best);
  const pick = top.find((x) => x.idx === q.occurrence) ?? top[0]!;
  return { start: pick.at, end: pick.at + q.quote.length };
}
