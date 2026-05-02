import { parseUnifiedDiff, syntheticUntrackedHunks } from "@/preview/diffParser";

interface DiffViewProps {
  diffText: string;
  /** Raw file text when diff empty / untracked */
  fileContentFallback?: string;
}

export function DiffView({ diffText, fileContentFallback }: DiffViewProps) {
  const hunks =
    diffText.trim().length > 0
      ? parseUnifiedDiff(diffText)
      : fileContentFallback
        ? syntheticUntrackedHunks(fileContentFallback)
        : [];

  if (hunks.length === 0) {
    return (
      <div className="empty-state">
        <p>No changes</p>
      </div>
    );
  }

  return (
    <pre
      style={{
        margin: 0,
        overflow: "auto",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--font-size-xs)",
      }}
    >
      {hunks.map((hunk, i) => (
        <div key={i}>
          <div style={{ color: "var(--fg-muted)", padding: "var(--space-1) 0" }}>{hunk.header}</div>
          {hunk.lines.map((line, j) => (
            <div
              key={j}
              className={`diff-line diff-line--${line.type}`}
            >
              <span className="diff-gutter">{line.oldLineNumber ?? ""}</span>
              <span className="diff-gutter">{line.newLineNumber ?? ""}</span>
              <span>{line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}</span>
              <span>{line.content}</span>
            </div>
          ))}
        </div>
      ))}
    </pre>
  );
}
