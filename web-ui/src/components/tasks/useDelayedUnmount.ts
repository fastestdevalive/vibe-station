import { useEffect, useState } from "react";

function reducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * True while `flag` is true and for `ms` after it falls, so an exit animation can play before the subtree
 * unmounts. Reduced motion is read live on every fall (the user can toggle it mid-session) and means 0 ms.
 */
export function useDelayedUnmount(flag: boolean, ms: number): boolean {
  const [mounted, setMounted] = useState(flag);
  useEffect(() => {
    if (flag) {
      setMounted(true);
      return;
    }
    const wait = reducedMotion() ? 0 : ms;
    if (wait === 0) {
      setMounted(false);
      return;
    }
    const id = setTimeout(() => setMounted(false), wait);
    return () => clearTimeout(id);
  }, [flag, ms]);
  return flag || mounted;
}
