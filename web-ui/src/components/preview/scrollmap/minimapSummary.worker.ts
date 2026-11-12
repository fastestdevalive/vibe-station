import { summarizeLines, bucketize } from "./minimapSummary";

let currentId = 0;

self.onmessage = async (e: MessageEvent<{ id: number; text: string }>) => {
  const { id, text } = e.data;
  if (id < currentId) return;
  currentId = id;

  const CHUNK_SIZE = 20_000;
  const allLines = text.split(/\r?\n/);
  const totalLines = allLines.length;

  if (totalLines > 100_000) {
    // Large-file tier (100,000–1,000,000 lines): bucketize into 4,096 buckets
    const fullIndent = new Uint8Array(totalLines);
    const fullLength = new Uint8Array(totalLines);

    for (let startLine = 1; startLine <= totalLines; startLine += CHUNK_SIZE) {
      if (currentId !== id) return;
      const startIndex = startLine - 1;
      const slice = allLines.slice(startIndex, startIndex + CHUNK_SIZE);
      const chunk = summarizeLines(slice);
      fullIndent.set(chunk.indent, startIndex);
      fullLength.set(chunk.length, startIndex);

      (self as unknown as Worker).postMessage({
        id,
        progressOnly: true,
        lines: chunk.lines,
        totalLines,
      });

      // Yield between chunks so a newer message can arrive mid-scan
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (currentId !== id) return;
    }

    const buckets = bucketize(fullIndent, fullLength, 4096);
    (self as unknown as Worker).postMessage(
      {
        id,
        bucketized: true,
        maxLength: buckets.maxLength,
        minIndent: buckets.minIndent,
        nonBlankShare: buckets.nonBlankShare,
        lines: totalLines,
        totalLines,
      },
      [buckets.maxLength.buffer, buckets.minIndent.buffer, buckets.nonBlankShare.buffer],
    );
    return;
  }

  // Normal tier (<= 100,000 lines)
  for (let startLine = 1; startLine <= totalLines; startLine += CHUNK_SIZE) {
    if (currentId !== id) return;
    const startIndex = startLine - 1;
    const slice = allLines.slice(startIndex, startIndex + CHUNK_SIZE);
    const chunk = summarizeLines(slice);
    if (currentId !== id) return;

    (self as unknown as Worker).postMessage(
      {
        id,
        startLine,
        indent: chunk.indent,
        length: chunk.length,
        lines: chunk.lines,
        totalLines,
      },
      [chunk.indent.buffer, chunk.length.buffer],
    );

    // Yield between chunks so cancellation works
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
