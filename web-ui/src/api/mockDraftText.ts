import { MAX_DRAFT_TEXT_BYTES } from "@/components/draftsync/constants";
import { ApiError } from "./errors";
import type { DraftTextDoc, WSEvent } from "./types";

const SCOPE_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const byteLen = (s: string) => new TextEncoder().encode(s).length;

/** Mock of the daemon's `draft_texts` rows: revision+1 per real change, an
 *  unchanged text is a no-op (no event), empty text keeps the tombstone row.
 *  Scope existence is not checked — the mock has no session/project registry. */
export function createMockDraftText(emit: (ev: WSEvent) => void) {
  const rows = new Map<string, DraftTextDoc>();
  const empty = (scope: string): DraftTextDoc => ({ scope, text: "", revision: 0, updatedAt: null, clientId: null });

  return {
    async listDraftTexts(): Promise<DraftTextDoc[]> {
      return [...rows.values()].map((r) => ({ ...r }));
    },

    async getDraftText(scope: string): Promise<DraftTextDoc> {
      const row = rows.get(scope);
      return row ? { ...row } : empty(scope);
    },

    async putDraftText(
      scope: string,
      text: string,
      clientId: string,
      _opts?: { keepalive?: boolean },
    ): Promise<DraftTextDoc> {
      if (!SCOPE_RE.test(scope)) throw new ApiError("bad scope", 400, "bad_scope");
      if (clientId.length < 1 || clientId.length > 64) throw new ApiError("bad client id", 400, "bad_client_id");
      if (byteLen(text) > MAX_DRAFT_TEXT_BYTES) throw new ApiError("draft too large", 413, "draft_too_large");

      const prev = rows.get(scope);
      if (prev && prev.text === text) return { ...prev };

      const updatedAt = new Date().toISOString();
      const row: DraftTextDoc = { scope, text, revision: (prev?.revision ?? 0) + 1, updatedAt, clientId };
      rows.set(scope, row);
      emit({ type: "draft-text:changed", scope, text, revision: row.revision, updatedAt, clientId });
      return { ...row };
    },
  };
}
