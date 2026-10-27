import { useEffect, useState } from "react";

/** The condition must hold this long before the line appears (ordinary turns write Working before turnState leaves idle). */
export const BACKGROUND_LINE_DELAY_MS = 1500;

interface Props {
  /** `sessionStates[id] ?? session.state` — never `lifecycleState`. */
  liveState: string | undefined;
  turnActive: boolean;
  turnState: string | undefined;
  queueDepth: number;
}

/** Passive "Agent is working in the background" note: lifecycle `working` while no turn is active. No Stop, no animation. */
export function BackgroundLine({ liveState, turnActive, turnState, queueDepth }: Props) {
  const cond = liveState === "working" && !turnActive && turnState !== "queued" && queueDepth <= 0;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!cond) {
      setShown(false);
      return;
    }
    const id = setTimeout(() => setShown(true), BACKGROUND_LINE_DELAY_MS);
    return () => clearTimeout(id);
  }, [cond]);
  if (!cond || !shown) return null;
  return (
    <div className="task-bg-line" role="status" data-testid="background-line">
      Agent is working in the background
    </div>
  );
}
