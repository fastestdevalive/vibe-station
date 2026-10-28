import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { SupportedCli } from "@/api/types";

/**
 * One in-flight/settled `getSupportedClis()` per api instance: the capability list (`supportsJson`,
 * `supportsTerminalDelivery`, ...) is static per daemon build, so every Terminal pane header control that gates on
 * it shares one GET instead of fetching its own copy. A failure is forgotten so the next mount retries.
 */
const cache = new WeakMap<ApiInstance, Promise<SupportedCli[]>>();

export function loadSupportedClis(api: ApiInstance): Promise<SupportedCli[]> {
  let p = cache.get(api);
  if (!p) {
    p = api.getSupportedClis();
    cache.set(api, p);
    p.catch(() => {
      if (cache.get(api) === p) cache.delete(api);
    });
  }
  return p;
}

/** The supported-CLI capabilities (null while loading or when `enabled` is false), plus whether the fetch failed. */
export function useSupportedClis(api: ApiInstance, enabled: boolean): { clis: SupportedCli[] | null; failed: boolean } {
  const [state, setState] = useState<{ clis: SupportedCli[] | null; failed: boolean }>({ clis: null, failed: false });
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    loadSupportedClis(api).then(
      (clis) => live && setState({ clis, failed: false }),
      () => live && setState({ clis: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [api, enabled]);
  return enabled ? state : { clis: null, failed: false };
}
