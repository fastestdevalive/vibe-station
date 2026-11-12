export const MINIMAP_MAX_LINES = 1_000_000;
export const MINIMAP_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
/** The cap as shown to people ("1,000,000 lines or 25 MB"). */
export const MINIMAP_CAP_LABEL = `${MINIMAP_MAX_LINES.toLocaleString("en-US")} lines or ${MINIMAP_MAX_BYTES / (1024 * 1024)} MB`;

export function overMinimapCap(lineCount: number, byteLength: number): boolean {
  return lineCount > MINIMAP_MAX_LINES || byteLength > MINIMAP_MAX_BYTES;
}

export interface ChunkSummary {
  indent: Uint8Array;
  length: Uint8Array;
  lines: number;
}

export interface BucketizedSummary {
  maxLength: Uint8Array;
  minIndent: Uint8Array;
  nonBlankShare: Uint8Array;
}

/**
 * Summarize a slice of text lines for minimap rendering.
 * Tab = 4 columns, indent and length clamped to 255.
 */
export function summarizeLines(slice: string[]): ChunkSummary {
  const count = slice.length;
  const indent = new Uint8Array(count);
  const length = new Uint8Array(count);

  for (let idx = 0; idx < count; idx++) {
    const line = slice[idx];
    if (line === undefined) continue;
    let col = 0;
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === " ") {
        col += 1;
      } else if (ch === "\t") {
        col += 4;
      } else {
        break;
      }
      i++;
    }

    if (i === line.length) {
      // Entirely whitespace / blank
      indent[idx] = 0;
      length[idx] = 0;
    } else {
      indent[idx] = Math.min(255, col);
      // Compute total line length in columns
      while (i < line.length) {
        const ch = line[i];
        if (ch === "\t") {
          col += 4;
        } else {
          col += 1;
        }
        i++;
      }
      length[idx] = Math.min(255, col);
    }
  }

  return { indent, length, lines: count };
}

/**
 * Bucketize large lines (e.g. 100,000–1,000,000 lines) into a fixed number of buckets (default 4096).
 * Per bucket: max length, min indent, non-blank share.
 */
export function bucketize(indent: Uint8Array, length: Uint8Array, bucketCount = 4096): BucketizedSummary {
  const maxLength = new Uint8Array(bucketCount);
  const minIndent = new Uint8Array(bucketCount);
  const nonBlankShare = new Uint8Array(bucketCount);

  const totalLines = indent.length;
  if (totalLines === 0) {
    return { maxLength, minIndent, nonBlankShare };
  }

  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor((b * totalLines) / bucketCount);
    let end = Math.floor(((b + 1) * totalLines) / bucketCount);
    if (end <= start) end = Math.min(totalLines, start + 1);

    let maxL = 0;
    let minI = 255;
    let nonBlankCount = 0;
    const bucketLines = end - start;

    for (let idx = start; idx < end; idx++) {
      const l = length[idx] ?? 0;
      if (l > 0) {
        nonBlankCount++;
        if (l > maxL) maxL = l;
        const ind = indent[idx] ?? 0;
        if (ind < minI) minI = ind;
      }
    }

    maxLength[b] = Math.min(255, maxL);
    minIndent[b] = nonBlankCount > 0 ? Math.min(255, minI) : 0;
    nonBlankShare[b] = bucketLines > 0 ? Math.round((nonBlankCount / bucketLines) * 255) : 0;
  }

  return { maxLength, minIndent, nonBlankShare };
}
