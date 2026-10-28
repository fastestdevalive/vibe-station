import type { DiffHunk } from "@/preview/diffParser";
import { Chip } from "@/components/ui/Chip";
import type { DiffComments } from "./useDiffComments";

/** `2 comments · click to expand` on a collapsed hunk row (jumping to a comment inside expands it first). */
export function HunkCommentChip({ dc, hunk, onExpand }: { dc: DiffComments | null | undefined; hunk: DiffHunk; onExpand: () => void }) {
  const n = dc?.countInHunk(hunk) ?? 0;
  if (n === 0) return null;
  const noun = n === 1 ? "comment" : "comments";
  return (
    <button type="button" className="comment-hunk-chip" onClick={onExpand} aria-label={`Expand hunk with ${n} ${noun}`}>
      <Chip>{`${n} ${noun}`}</Chip> <span className="comment-hunk-chip__hint">click to expand</span>
    </button>
  );
}
