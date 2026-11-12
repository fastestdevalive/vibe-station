import { memo } from "react";
import type { ChainMarkKind, ChainMarks as Marks } from "./chainGeometry";

/** Chain width in px: the 10px line column plus the find-hit column to its right. */
const CHAIN_W = 16;

/** Horizontal extent of each mark kind: a turn is a 10px line, a step a shorter one, hits sit right of the rail. */
const MARK_X: Record<ChainMarkKind, [x: number, w: number]> = {
  turn: [1, 10],
  turnIn: [1, 10],
  turnReview: [1, 10],
  turnErr: [1, 10],
  turnLive: [1, 10],
  step: [3, 6],
  stepErr: [3, 6],
  stepAsk: [3, 6],
  brk: [0, 12],
  hit: [12, 4],
  hitCur: [11, 5],
  hitPeek: [11, 5],
};

/** Paint order: steps under turns, turns under hits. */
const ORDER: ChainMarkKind[] = [
  "brk", "step", "stepAsk", "stepErr", "turn", "turnIn", "turnReview", "turnErr", "turnLive", "hit", "hitPeek", "hitCur",
];

function pathFor(kind: ChainMarkKind, ys: readonly number[]): string {
  const [x, w] = MARK_X[kind];
  let d = "";
  for (const y of ys) d += `M${x} ${y}h${w}`;
  return d;
}

/** Every chain line in one SVG: one path per mark kind, never one element per turn. */
export const ChainMarks = memo(function ChainMarks({ marks, height }: { marks: Marks; height: number }) {
  return (
    <svg
      className="ol__marks"
      width={CHAIN_W}
      height={height}
      viewBox={`0 0 ${CHAIN_W} ${height}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path className="ol__m ol__m--spine" d={`M6 0V${height}`} />
      {ORDER.map((kind) =>
        marks[kind].length > 0 ? (
          <path key={kind} className={`ol__m ol__m--${kind}`} data-kind={kind} d={pathFor(kind, marks[kind])} />
        ) : null,
      )}
    </svg>
  );
});
