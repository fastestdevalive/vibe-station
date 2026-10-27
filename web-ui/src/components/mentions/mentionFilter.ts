export function scoreLabel(query: string, label: string, secondary?: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const l = label.toLowerCase();
  if (l.startsWith(q)) {
    return 3;
  }

  // Word-start match in label: search for word boundary delimiters followed by q
  const isWordBoundary = (str: string, index: number): boolean => {
    return index === 0 || /[\s\-_/.]/.test(str[index - 1]!);
  };

  let searchIndex = 0;
  while (searchIndex < l.length) {
    const idx = l.indexOf(q, searchIndex);
    if (idx === -1) break;
    if (isWordBoundary(l, idx)) {
      return 2;
    }
    searchIndex = idx + 1;
  }

  if (l.includes(q)) {
    return 1;
  }

  if (secondary) {
    const s = secondary.toLowerCase();
    if (s.startsWith(q)) {
      return 2;
    }
    let sIndex = 0;
    while (sIndex < s.length) {
      const idx = s.indexOf(q, sIndex);
      if (idx === -1) break;
      if (isWordBoundary(s, idx)) {
        return 2;
      }
      sIndex = idx + 1;
    }
    if (s.includes(q)) {
      return 1;
    }
  }

  return 0;
}

export function rankItems<T extends { label: string; secondary?: string }>(items: T[], query: string): T[] {
  const q = query.trim();
  if (!q) {
    return [...items];
  }

  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const score = scoreLabel(q, item.label, item.secondary);
    if (score > 0) {
      scored.push({ item, score });
    }
  }

  // Stable sort descending by score
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

export function highlightMatch(label: string, query: string): HighlightSegment[] {
  const q = query.toLowerCase();
  if (!q || !label) {
    return [{ text: label, hit: false }];
  }

  const idx = label.toLowerCase().indexOf(q);
  if (idx === -1) {
    return [{ text: label, hit: false }];
  }

  const segments: HighlightSegment[] = [];
  if (idx > 0) {
    segments.push({ text: label.slice(0, idx), hit: false });
  }
  segments.push({ text: label.slice(idx, idx + query.length), hit: true });
  if (idx + query.length < label.length) {
    segments.push({ text: label.slice(idx + query.length), hit: false });
  }

  return segments;
}
