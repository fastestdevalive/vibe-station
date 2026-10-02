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
