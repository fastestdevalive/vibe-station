import { useEffect, useState } from "react";
import type { ApiInstance, ConnectionState } from "@/api";

type ConnApi = Partial<Pick<ApiInstance, "getConnectionState" | "subscribeConnection">>;

const up = (s: ConnectionState | undefined) => s === undefined || s === "online";

/** Daemon connection is up (Add / Send / Copy are disabled with a reason while it is not). An API without a connection state counts as up. */
export function useApiOnline(api: ConnApi): boolean {
  const [online, setOnline] = useState(() => up(api.getConnectionState?.()));
  useEffect(() => {
    setOnline(up(api.getConnectionState?.()));
    return api.subscribeConnection?.((s) => setOnline(up(s)));
  }, [api]);
  return online;
}
