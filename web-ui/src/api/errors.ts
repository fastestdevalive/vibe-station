import type { ArtifactErrorCode, CommentErrorCode } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Machine-readable `code` from the daemon's `{ error, code }` body, when present. */
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Machine-readable detail the daemon attaches to a failed `GET /artifacts/:id/content`. */
export interface ArtifactReadDetail {
  size?: number;
  mime?: string;
  detail?: string;
}

/**
 * A failed artifact read. `code` is the daemon's `error` code (`ARTIFACT_NOT_FOUND`, `ARTIFACT_MISSING`,
 * `ARTIFACT_DENIED`, `ARTIFACT_UNREADABLE`, `ARTIFACT_BINARY`, `ARTIFACT_TOO_LARGE`); `info` carries
 * `size`/`mime`/`detail` for the state panels.
 */
export class ArtifactApiError extends ApiError {
  declare code?: ArtifactErrorCode;
  constructor(
    message: string,
    status: number,
    code: ArtifactErrorCode | undefined,
    public info: ArtifactReadDetail = {},
  ) {
    super(message, status, code);
    this.name = "ArtifactApiError";
  }
}

/** Kept as an alias: the class is thrown by list / pin / remove as well as reads. */
export const ArtifactReadError = ArtifactApiError;
export type ArtifactReadError = ArtifactApiError;

/** Extra fields the review routes put beside `error` / `message` on a failure body. */
export interface ReviewErrorInfo {
  /** `comments_changed`: how many of the sent ids still exist. */
  remaining?: number;
  /** `review_too_large`: the limit that was exceeded. */
  limit?: number;
  unit?: "comments" | "bytes";
}

/**
 * A failed review-comment call. `code` is the daemon's machine-readable `error` (`comments_changed`,
 * `review_too_large`, `cap_reached`, ...); `info` carries `remaining` / `limit` / `unit` when present.
 */
export class ReviewApiError extends ApiError {
  declare code?: CommentErrorCode;
  constructor(
    message: string,
    status: number,
    code: CommentErrorCode | undefined,
    public info: ReviewErrorInfo = {},
  ) {
    super(message, status, code);
    this.name = "ReviewApiError";
  }
}

/** A failed response body, parsed once for every error class: `error` (else `code`), `message`, extra fields. */
export interface ParsedErrorBody {
  code: string | undefined;
  message: string;
  /** The parsed JSON object, or `{}` for a non-JSON body. */
  fields: Record<string, unknown>;
}

export function parseErrorBody(text: string, fallback: string): ParsedErrorBody {
  let code: string | undefined;
  let message = text || fallback;
  let fields: Record<string, unknown> = {};
  try {
    const j = JSON.parse(text) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) {
      fields = j as Record<string, unknown>;
      if (typeof fields.error === "string") code = fields.error;
      else if (typeof fields.code === "string") code = fields.code;
      if (typeof fields.message === "string") message = fields.message;
    }
  } catch {
    /* non-JSON body: keep the raw text */
  }
  return { code, message, fields };
}

/** Error-code compare for an unknown thrown value (works for any `ApiError` subclass). */
export const errorCodeOf = (e: unknown): string | undefined => (e instanceof ApiError ? e.code : undefined);
