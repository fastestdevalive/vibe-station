import { ApiError } from "./errors";
import type { TranscriptOutlineSummary, TranscriptOutlineWindow } from "./types";

/** Thrown when the daemon has no outline endpoint (an older daemon answers with the SPA page). */
export const OUTLINE_UNSUPPORTED = "OUTLINE_UNSUPPORTED";
/** The daemon's `503` code while the session's outline is disabled (schema failure). */
export const OUTLINE_UNAVAILABLE = "OUTLINE_UNAVAILABLE";

interface Deps {
  baseUrl: () => string;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

function isSummaryBody(body: unknown): body is TranscriptOutlineSummary {
  const b = body as Partial<TranscriptOutlineSummary> | null;
  return typeof b === "object" && b !== null && Array.isArray(b.tools) && Array.isArray(b.edits) && Array.isArray(b.errors);
}

function isWindowBody(body: unknown): body is TranscriptOutlineWindow {
  const b = body as Partial<TranscriptOutlineWindow> | null;
  return typeof b === "object" && b !== null && Array.isArray(b.turns);
}

/** Whole-chat outline REST methods; kept out of `client.ts` (over the size guideline) and spread into the client object. */
export function createTranscriptOutlineClient({ baseUrl, apiFetch }: Deps) {
  /** GET a JSON outline body; keeps the daemon's `code` on errors and treats a non-JSON or shape-less 200 as unsupported. */
  async function getOutline<T>(path: string, signal: AbortSignal | undefined, isBody: (body: unknown) => body is T): Promise<T> {
    const res = await apiFetch(`${baseUrl()}${path}`, signal ? { signal } : undefined);
    if (!res.ok) {
      // The hook tells an older daemon (a bare 404/405/501 with no code) from a real error by the code.
      const text = await res.text();
      let code: string | undefined;
      try {
        const body = JSON.parse(text) as { code?: unknown };
        if (typeof body.code === "string") code = body.code;
      } catch {
        /* non-JSON body: no code */
      }
      throw new ApiError(text || res.statusText, res.status, code);
    }
    const unsupported = () => new ApiError("transcript outline is not supported by this daemon", 404, OUTLINE_UNSUPPORTED);
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) throw unsupported();
    const body: unknown = await res.json();
    if (!isBody(body)) throw unsupported();
    return body;
  }

  return {
    /** Fixed-size bucketed counts of the whole chat (`GET /sessions/:id/transcript/outline`). */
    getTranscriptOutline(sessionId: string, signal?: AbortSignal): Promise<TranscriptOutlineSummary> {
      return getOutline(`/sessions/${encodeURIComponent(sessionId)}/transcript/outline`, signal, isSummaryBody);
    },

    /** Turns `from..from+limit` by index (`GET /sessions/:id/transcript/outline/window`). */
    getTranscriptOutlineWindow(
      sessionId: string,
      params: { from: number; limit?: number },
      signal?: AbortSignal,
    ): Promise<TranscriptOutlineWindow> {
      const qp = new URLSearchParams({ from: String(params.from) });
      if (params.limit != null) qp.set("limit", String(params.limit));
      return getOutline(
        `/sessions/${encodeURIComponent(sessionId)}/transcript/outline/window?${qp.toString()}`,
        signal,
        isWindowBody,
      );
    },
  };
}
