import type {
  ArtifactScopeKind,
  CommentDiffScope,
  CommentPathKind,
  CommentSide,
  CommentSurface,
} from "@/api/types";

/** What a new comment is anchored to, before the daemon has seen it (`CreateCommentRequest` minus id/path/text). */
export interface CommentAnchor {
  surface: CommentSurface;
  diffScope?: CommentDiffScope;
  baseSha?: string;
  side?: CommentSide;
  /** Side-relative source span (markdown: the block range from the AST). */
  lineStart?: number;
  lineEnd?: number;
  oldStart?: number;
  oldEnd?: number;
  newStart?: number;
  newEnd?: number;
  quote: string;
  prefix: string;
  suffix: string;
  occurrence: number;
}

/** One line of a corpus (`n` = the line number on its side). */
export interface LineText {
  n: number;
  text: string;
}
