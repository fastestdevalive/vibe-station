import type { ApiInstance } from "@/api";
import { ensureLoaded, useModesStore } from "@/store/modesStore";

/**
 * Resolve the default agent mode id for a quick-created session. Awaits the
 * lazy modes-store load, then returns the first mode in the store's Map, or
 * `null` when no modes are configured. Callers use `null` to render a
 * disabled + tooltip state instead of submitting.
 */
export async function resolveDefaultModeId(api: ApiInstance): Promise<string | null> {
  await ensureLoaded(api);
  return useModesStore.getState().modes.values().next().value?.id ?? null;
}
