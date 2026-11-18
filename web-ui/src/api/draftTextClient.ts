import { ApiError, parseErrorBody } from "./errors";
import type { DraftTextDoc } from "./types";

interface Deps {
  baseUrl: () => string;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Map a failed draft-text response to an `ApiError` carrying the daemon's code
 *  (`bad_scope`, `bad_client_id`, `scope_not_found`, `draft_too_large`). */
async function failure(res: Response): Promise<never> {
  const { code, message } = parseErrorBody(await res.text(), res.statusText);
  throw new ApiError(message, res.status, code);
}

async function parseDoc(res: Response): Promise<DraftTextDoc> {
  if (!res.ok) return failure(res);
  return (await res.json()) as DraftTextDoc;
}

/** Server-owned draft-text REST methods; kept out of `client.ts` (over the size
 *  guideline) and spread into the client object, mirrored by `mockDraftText.ts`. */
export function createDraftTextClient({ baseUrl, apiFetch }: Deps) {
  return {
    /** Every scope's row, tombstones (empty text) included (`GET /draft-texts`). */
    async listDraftTexts(): Promise<DraftTextDoc[]> {
      const res = await apiFetch(`${baseUrl()}/draft-texts`);
      if (!res.ok) return failure(res);
      const body = (await res.json()) as { drafts?: DraftTextDoc[] };
      return body.drafts ?? [];
    },

    /** One scope's row; an absent row resolves to the revision-0 empty doc. */
    async getDraftText(scope: string): Promise<DraftTextDoc> {
      return parseDoc(await apiFetch(`${baseUrl()}/draft-texts/${encodeURIComponent(scope)}`));
    },

    /** Last-writer-wins PUT; `keepalive` is for the pagehide flush only. */
    async putDraftText(
      scope: string,
      text: string,
      clientId: string,
      opts?: { keepalive?: boolean },
    ): Promise<DraftTextDoc> {
      const init: RequestInit = {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ text, clientId }),
      };
      if (opts?.keepalive) init.keepalive = true;
      return parseDoc(await apiFetch(`${baseUrl()}/draft-texts/${encodeURIComponent(scope)}`, init));
    },
  };
}
