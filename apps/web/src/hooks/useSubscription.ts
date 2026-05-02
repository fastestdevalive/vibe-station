import { useEffect, useRef } from "react";
import type { WSEvent } from "@/api/types";

/** Stable WS subscription when session ids change; handler always sees latest closure via ref. */
export function useSubscription(
  sessionIds: string[],
  onEvent: (e: WSEvent) => void,
  apiSubscribe: (
    ids: string[],
    cb: (e: WSEvent) => void,
  ) => () => void,
) {
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  const key = [...sessionIds].sort().join(",");

  useEffect(() => {
    if (!key) return undefined;
    const ids = key.split(",").filter(Boolean);
    return apiSubscribe(ids, (e) => cbRef.current(e));
  }, [key, apiSubscribe]);
}
