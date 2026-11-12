import { useFindMarks } from "./FindMarksContext";
import { locate } from "@/lib/findTerms";

export interface FindTextProps {
  text: string;
  keyPrefix: string;
}

/**
 * Splits plain text into strings and `<mark className="find-hit" data-find-key="{keyPrefix}:{n}">`.
 * When no find context is active, terms are empty, or text lacks any term, returns the plain text.
 */
export function FindText({ text, keyPrefix }: FindTextProps) {
  const findMarks = useFindMarks();
  if (!findMarks || findMarks.terms.length === 0 || !text) {
    return <>{text}</>;
  }

  // Multi-term queries: locate() requires all terms to be present, otherwise returns []
  const ranges = locate(text, findMarks.terms);
  if (ranges.length === 0) {
    return <>{text}</>;
  }

  const pieces: React.ReactNode[] = [];
  let lastIndex = 0;
  let markIndex = 0;

  for (const [start, end] of ranges) {
    if (start > lastIndex) {
      pieces.push(text.slice(lastIndex, start));
    }
    const key = `${keyPrefix}:${markIndex++}`;
    pieces.push(
      <mark key={key} className="find-hit" data-find-key={key}>
        {text.slice(start, end)}
      </mark>,
    );
    lastIndex = end;
  }

  if (lastIndex < text.length) {
    pieces.push(text.slice(lastIndex));
  }

  return <>{pieces}</>;
}
