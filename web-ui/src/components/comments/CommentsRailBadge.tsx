import { Chip } from "@/components/ui/Chip";
import { useCommentCount } from "./commentSelectors";

/** The count chip itself (nothing at 0). */
export function CommentCountChip({ count: n }: { count: number }) {
  if (n <= 0) return null;
  return (
    <Chip size="sm" aria-label={`${n} ${n === 1 ? "comment" : "comments"}`} className="comment-rail-badge">
      {n > 99 ? "99+" : n}
    </Chip>
  );
}

/** Comment count on the tools toggle (top bar) while the pane is collapsed (nothing at 0). */
export function CommentsRailBadge({ scopeId }: { scopeId: string }) {
  return <CommentCountChip count={useCommentCount(scopeId === "__none__" ? null : scopeId)} />;
}
