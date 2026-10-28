import { ArtifactApiError, parseErrorBody } from "./errors";
import type { ArtifactErrorCode, ArtifactListResponse, ArtifactRow, PinArtifactResponse } from "./types";

/** Body of `GET /artifacts/:id/content`: text (maybe truncated) or an image blob. */
export type ArtifactContent =
  | { kind: "text"; body: string; /** Full byte size when the daemon cut the text at 1 MiB. */ truncatedTotal?: number }
  | { kind: "image"; blob: Blob };

export type ArtifactScopeParam = "worktree" | "project";

interface Deps {
  baseUrl: () => string;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

async function failure(res: Response): Promise<never> {
  const { code, message, fields: j } = parseErrorBody(await res.text(), res.statusText);
  throw new ArtifactApiError(message, res.status, code as ArtifactErrorCode | undefined, {
    ...(typeof j.size === "number" ? { size: j.size } : {}),
    ...(typeof j.mime === "string" ? { mime: j.mime } : {}),
    ...(typeof j.detail === "string" ? { detail: j.detail } : {}),
  });
}

/**
 * Artifact REST methods (users cannot add artifacts by hand, so there is no `addArtifact`).
 * Kept out of `client.ts` (over the size guideline); spread into the client object.
 */
export function createArtifactsClient({ baseUrl, apiFetch }: Deps) {
  return {
    async listArtifacts(scopeId: string, scope: ArtifactScopeParam = "worktree"): Promise<ArtifactListResponse> {
      const seg = scope === "project" ? "projects" : "worktrees";
      const res = await apiFetch(`${baseUrl()}/${seg}/${encodeURIComponent(scopeId)}/artifacts`);
      if (!res.ok) return failure(res);
      return res.json() as Promise<ArtifactListResponse>;
    },

    async pinArtifact(id: string, pinned: boolean): Promise<ArtifactRow> {
      const res = await apiFetch(`${baseUrl()}/artifacts/${encodeURIComponent(id)}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned }),
      });
      if (!res.ok) return failure(res);
      return ((await res.json()) as PinArtifactResponse).artifact;
    },

    async removeArtifact(id: string): Promise<{ ok: true }> {
      const res = await apiFetch(`${baseUrl()}/artifacts/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) return failure(res);
      return res.json() as Promise<{ ok: true }>;
    },

    async getArtifactContent(id: string): Promise<ArtifactContent> {
      const res = await apiFetch(`${baseUrl()}/artifacts/${encodeURIComponent(id)}/content`);
      if (!res.ok) return failure(res);
      const type = res.headers.get("content-type") ?? "";
      if (type.startsWith("image/")) return { kind: "image", blob: await res.blob() };
      const body = await res.text();
      const total = Number(res.headers.get("x-vst-truncated-total"));
      return Number.isFinite(total) && total > 0 ? { kind: "text", body, truncatedTotal: total } : { kind: "text", body };
    },
  };
}

export type ArtifactsClient = ReturnType<typeof createArtifactsClient>;

