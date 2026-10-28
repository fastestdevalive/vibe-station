import { createContext, useContext } from "react";
import type { ArtifactScopeKind, CommentDiffScope, CommentPathKind, CommentSurface, ReviewComment } from "@/api/types";
import type { MentionEditorConfig } from "@/components/mentions/types";
import type { DescribeContext, SelectionResult } from "./anchorGeometry";
import { buildSurfaceComments, type SurfaceComments } from "./rowIndex";
import type { RemovedNotice } from "./CommentBox";
import type { PinMeasurer } from "./pinMeasurer";
import type { CommentAnchor, LineText } from "./types";

export interface OpenOpts {
  /** Where focus goes when the box closes (the gutter `+` / pin that opened it). */
  returnFocus?: HTMLElement | null;
  /** Element the box is positioned against on surfaces without rows (rendered markdown). */
  anchorEl?: HTMLElement | null;
}

export interface OpenNew {
  kind: "new";
  anchor: CommentAnchor;
  /** `anchorHash` of the anchor (draft key part). */
  hash: string;
  /** Comment id minted once when the box opens and reused by every Save retry (the daemon create is idempotent by id). */
  newId: string;
  returnFocus: HTMLElement | null;
  anchorEl: HTMLElement | null;
}

export interface OpenEdit {
  kind: "edit";
  id: string;
  /** Last known copy: the box outlives a comment another device removed. */
  snapshot: ReviewComment;
  returnFocus: HTMLElement | null;
  anchorEl: HTMLElement | null;
}

export type OpenBox = OpenNew | OpenEdit;

/** Old / new text rows a diff view registers so selections get prefix / suffix / occurrence from the diff. */
export interface DiffCorpus {
  oldRows: readonly LineText[];
  newRows: readonly LineText[];
}

export interface CommentSurfaceValue {
  enabled: boolean;
  /** Why commenting is unavailable here (commit / image / binary); shown on the disabled Comment button. */
  disabledReason: string | null;
  scopeKind: ArtifactScopeKind;
  scopeId: string;
  path: string;
  pathKind: CommentPathKind;
  diffScope: CommentDiffScope | undefined;
  offline: boolean;
  capReached: boolean;
  fileLines: readonly string[] | null;
  /** The `[data-comment-surface]` scroll element (selection geometry, popover bounds). */
  rootEl: HTMLElement | null;
  /** Every comment on this file (all surfaces). */
  all: ReviewComment[];
  /** Comments of the scope, for pin ordinals. */
  total: number;
  open: OpenBox | null;
  /** The text of the open `new` box changed under it. */
  stale: boolean;
  /** Removed-by-another-device notice for the open `edit` box. */
  removed: RemovedNotice | undefined;
  saveError: string | null;
  saving: boolean;
  mentions: MentionEditorConfig;
  /** This surface's comments, indexed by row. */
  forSurface: (surface: CommentSurface) => SurfaceComments;
  openNew: (anchor: CommentAnchor, opts?: OpenOpts) => void;
  openEdit: (id: string, opts?: OpenOpts) => void;
  close: () => void;
  /** Close without moving focus (an outside tap on a floating box). */
  dismiss: () => void;
  /** A floating box reports whether it holds unsaved text (a pin tap must not replace it). */
  setBoxDirty: (dirty: boolean) => void;
  save: (plainText: string) => void;
  remove: (id: string) => void;
  restoreRemoved: (plainText: string) => void;
  discardRemoved: () => void;
  copyText: (plainText: string) => void;
  /** Selection → anchor, picking the surface from the DOM under the selection. */
  describe: (range: Range) => SelectionResult;
  /** Gutter `+` on a row element → whole-line anchor. */
  describeRowEl: (row: HTMLElement) => CommentAnchor | null;
  describeContext: (surface: CommentSurface) => DescribeContext | null;
  /** A diff view publishes its hunk rows here (and clears them on unmount). */
  setDiffCorpus: (c: DiffCorpus | null) => void;
  pinLabel: (c: ReviewComment) => string;
  /** Places the pins in the right gutter (one per surface). */
  pinMeasurer: PinMeasurer;
  /** The open "new comment" box as a comment-shaped value (its span is marked dashed, a draft pin sits at its end). */
  draft: ReviewComment | null;
  /** Id of the comment whose edit box is open (its pin gets the active ring). */
  activeId: string | null;
  attachedLabel: (c: ReviewComment) => string | undefined;
}

export const CommentSurfaceContext = createContext<CommentSurfaceValue | null>(null);

/** The surrounding comment surface, or null (chat bubbles, tool cards, settings previews). */
export function useCommentSurface(): CommentSurfaceValue | null {
  return useContext(CommentSurfaceContext);
}

export { buildSurfaceComments };
