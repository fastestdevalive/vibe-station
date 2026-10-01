import { useEffect, useState } from "react";
import { useDemoEnv } from "../context/DemoEnv";

const W = /^\(\s*(min|max)-width:\s*(\d+(?:\.\d+)?)px\s*\)$/;
function evalQuery(q: string, w: number | null): boolean | null {
  const m = W.exec(q); if (!m || w === null) return null;
  return m[1] === 'max' ? w <= Number(m[2]) : w >= Number(m[2]);
}

export function useMediaQuery(query: string): boolean {
  const env = useDemoEnv();
  const w = env.viewport?.w ?? null;
  
  const widthQueryMatches = evalQuery(query, w);

  const [matches, setMatches] = useState(() => {
    if (widthQueryMatches !== null) return widthQueryMatches;
    if (typeof window === "undefined") return false;
    if (typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (widthQueryMatches !== null) {
      setMatches(widthQueryMatches);
      return;
    }
    if (typeof window.matchMedia !== "function") return;

    const mq = window.matchMedia(query);
    const handler = () => setMatches(mq.matches);
    mq.addEventListener("change", handler);
    setMatches(mq.matches);
    return () => mq.removeEventListener("change", handler);
  }, [query, widthQueryMatches]);

  return matches;
}
