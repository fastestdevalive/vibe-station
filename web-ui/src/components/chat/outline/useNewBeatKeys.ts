import { useEffect, useRef, useState } from "react";
import type { TurnNode } from "./buildTurnOutline";

/** How long a newly arrived beat stays highlighted before it reads as a normal beat. */
const NEW_BEAT_HIGHLIGHT_MS = 1200;

/**
 * Tracks newly arrived beats during a live streaming turn and highlights them
 * for `NEW_BEAT_HIGHLIGHT_MS` before settling into regular beats.
 *
 * Seeded from the initial transcript so existing beats never flash on load.
 * Incremental: only inspects the live turn and newly arrived settled turns.
 */
export function useNewBeatKeys(nodes: TurnNode[]): ReadonlySet<string> {
  const knownKeysRef = useRef<Set<string> | null>(null);
  const knownSettledNodesRef = useRef<Set<string>>(new Set());
  const [newBeatKeys, setNewBeatKeys] = useState<ReadonlySet<string>>(() => new Set());
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Clear timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  // Seed from the first non-empty list, so a transcript that loads after mount
  // (live turn included) is not flashed as new.
  if (knownKeysRef.current === null && nodes.length > 0) {
    const initialKeys = new Set<string>();
    for (const node of nodes) {
      if (!node.live) knownSettledNodesRef.current.add(node.key);
      for (const beat of node.beats) {
        initialKeys.add(beat.key);
      }
    }
    knownKeysRef.current = initialKeys;
  }

  useEffect(() => {
    if (!knownKeysRef.current) return;

    const liveTurn = nodes.find((n) => n.live);
    const freshKeys: string[] = [];

    if (liveTurn) {
      for (const beat of liveTurn.beats) {
        if (!knownKeysRef.current.has(beat.key)) {
          freshKeys.push(beat.key);
          knownKeysRef.current.add(beat.key);
        }
      }
    }

    // Register beats from newly arrived settled turns incrementally
    for (const node of nodes) {
      if (node.live) continue;
      if (knownSettledNodesRef.current.has(node.key)) continue;
      knownSettledNodesRef.current.add(node.key);
      for (const beat of node.beats) {
        knownKeysRef.current.add(beat.key);
      }
    }

    if (freshKeys.length > 0) {
      setNewBeatKeys((prev) => {
        const next = new Set(prev);
        for (const k of freshKeys) next.add(k);
        return next;
      });

      const timer = setTimeout(() => {
        timersRef.current.delete(timer);
        setNewBeatKeys((prev) => {
          const next = new Set(prev);
          for (const k of freshKeys) next.delete(k);
          return next;
        });
      }, NEW_BEAT_HIGHLIGHT_MS);

      timersRef.current.add(timer);
    }
  }, [nodes]);

  return newBeatKeys;
}
