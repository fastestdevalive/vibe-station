import type { ApiInstance } from "@/api";
import { errorCodeOf } from "@/api/errors";
import type { ArtifactRow } from "@/api/types";
import { PIN_LIMIT, useArtifactsStore } from "./artifactsStore";

/**
 * Pin / unpin a row and patch the store. Returns `null` on success (or a row that no longer exists), else the
 * notice to show. One owner for the pin-limit copy.
 */
export async function toggleArtifactPin(api: Pick<ApiInstance, "pinArtifact">, scopeId: string, row: ArtifactRow): Promise<string | null> {
  try {
    const updated = await api.pinArtifact(row.id, !row.pinned);
    useArtifactsStore.getState().patchRow(scopeId, updated);
    return null;
  } catch (e) {
    const code = errorCodeOf(e);
    if (code === "PIN_LIMIT") return `${PIN_LIMIT} pinned is the limit`;
    return code === "ARTIFACT_NOT_FOUND" ? null : "Couldn’t update this artifact";
  }
}

/** Remove a row: hidden locally on success or when the daemon already forgot it; `"failed"` otherwise. */
export async function removeArtifactRow(api: Pick<ApiInstance, "removeArtifact">, scopeId: string, row: ArtifactRow): Promise<"removed" | "failed"> {
  try {
    await api.removeArtifact(row.id);
  } catch (e) {
    if (errorCodeOf(e) !== "ARTIFACT_NOT_FOUND") return "failed";
  }
  useArtifactsStore.getState().hideRow(scopeId, row.id);
  return "removed";
}
