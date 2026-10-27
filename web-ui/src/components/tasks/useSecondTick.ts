import { useEffect, useState } from "react";
import { useNowTick } from "@/hooks/useNowTick";

/** 1 s local tick, alive only while `active` and cleared when it turns false/unmounts; otherwise the shared minute tick. */
export function useSecondTick(active: boolean): number {
  const minute = useNowTick();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return active ? now : Math.max(minute, now);
}
