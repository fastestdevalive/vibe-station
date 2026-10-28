import type { ReviewComment } from "@/api/types";
import { anchorLabel } from "./anchorGeometry";
import { CommentBox } from "./CommentBox";
import { draftKey, editDraftKey } from "./commentDrafts";
import { commentSpan, rowKey, type RowSide, type SurfaceComments } from "./rowIndex";
import type { CommentSurfaceValue, OpenNew } from "./CommentSurfaceContext";

/** Add box for the open `new` anchor (`floating`: the rendered-markdown float, closed by an outside tap). */
export function NewCommentBox({ surface, open, floating }: { surface: CommentSurfaceValue; open: OpenNew; floating?: boolean }) {
  const scopeKey = `${surface.scopeKind}:${surface.scopeId}`;
  return (
    <CommentBox
      key={`new-${open.hash}`}
      mode="new"
      label={anchorLabel(open.anchor)}
      quote={open.anchor.quote}
      draftKey={draftKey(scopeKey, surface.path, open.hash)}
      draftAnchor={open.anchor}
      mentions={surface.mentions}
      offline={surface.offline}
      capReached={surface.capReached}
      stale={surface.stale}
      error={surface.saveError}
      busy={surface.saving}
      onSave={surface.save}
      onCancel={surface.close}
      onDismiss={floating ? surface.dismiss : undefined}
      onDirtyChange={floating ? surface.setBoxDirty : undefined}
    />
  );
}

/** Edit box for a saved comment (the snapshot outlives a comment another device removed). */
export function EditCommentBox({ surface, comment, floating }: { surface: CommentSurfaceValue; comment: ReviewComment; floating?: boolean }) {
  const scopeKey = `${surface.scopeKind}:${surface.scopeId}`;
  return (
    <CommentBox
      key={`edit-${comment.id}`}
      mode="edit"
      label={anchorLabel(comment)}
      quote={comment.quote}
      comment={comment}
      draftKey={editDraftKey(scopeKey, comment.id)}
      seedText={comment.text}
      mentions={surface.mentions}
      offline={surface.offline}
      removed={surface.removed}
      error={surface.saveError}
      busy={surface.saving}
      onSave={surface.save}
      onCancel={surface.close}
      onRestore={surface.restoreRemoved}
      onDiscard={surface.discardRemoved}
      onCopyText={surface.copyText}
      onDismiss={floating ? surface.dismiss : undefined}
      onDirtyChange={floating ? surface.setBoxDirty : undefined}
    />
  );
}

/** Row key of the line an anchor / comment ends on. */
function endKey(side: RowSide | undefined, lineEnd: number | undefined, lineStart: number | undefined): string | null {
  const n = lineEnd ?? lineStart;
  return n == null ? null : rowKey(side ?? "new", n);
}

/** Rows live inside `<pre>`s whose own pointer handlers (LSP hover / go-to-definition) must not see the box. */
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

interface CommentRowStackProps {
  surface: CommentSurfaceValue;
  view: SurfaceComments;
  side: RowSide;
  n: number;
}

/**
 * Everything that renders UNDER a commented row: the saved cards of the comments ending on it, the edit box
 * of the one being edited (also when another device removed it), and the add box of a new anchor that ends
 * here (`Changes` board `.cmt`). Row-based surfaces only (diff, code); rendered markdown uses a float.
 */
export function CommentRowStack({ surface, view, side, n }: CommentRowStackProps) {
  const key = rowKey(side, n);
  const ending = view.ends.get(key);
  const open = surface.open;
  const addHere =
    open?.kind === "new" && open.anchor.surface !== "markdown" && endKey(open.anchor.side, open.anchor.lineEnd, open.anchor.lineStart) === key;
  const orphanEdit = (() => {
    if (open?.kind !== "edit" || open.snapshot.surface === "markdown") return null;
    if (ending?.some((c) => c.id === open.id)) return null;
    const span = commentSpan(open.snapshot);
    return span && rowKey(span.side, span.end) === key ? open.snapshot : null;
  })();
  if (!ending?.length && !addHere && !orphanEdit) return null;

  return (
    <div
      className="comment-rowstack"
      data-comment-rowstack={key}
      onClick={stop}
      onMouseDown={stop}
      onMouseUp={stop}
      onMouseMove={stop}
      onPointerMove={stop}
      onPointerEnter={stop}
      onPointerLeave={stop}
      onCopy={stop}
    >
      {ending?.map((c) =>
        open?.kind === "edit" && open.id === c.id ? (
          <EditCommentBox key={c.id} surface={surface} comment={c} />
        ) : (
          <CommentBox
            key={c.id}
            mode="view"
            label={anchorLabel(c)}
            quote={c.quote}
            comment={c}
            offline={surface.offline}
            attachedLabel={surface.attachedLabel(c)}
            onEdit={() => surface.openEdit(c.id)}
            onDelete={() => surface.remove(c.id)}
          />
        ),
      )}
      {orphanEdit ? <EditCommentBox surface={surface} comment={orphanEdit} /> : null}
      {addHere && open?.kind === "new" ? <NewCommentBox surface={surface} open={open} /> : null}
    </div>
  );
}
