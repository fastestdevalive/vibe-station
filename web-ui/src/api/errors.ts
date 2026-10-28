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
export class ArtifactReadError extends ApiError {
  constructor(
    message: string,
    status: number,
    code: string | undefined,
    public info: ArtifactReadDetail = {},
  ) {
    super(message, status, code);
    this.name = "ArtifactReadError";
  }
}
