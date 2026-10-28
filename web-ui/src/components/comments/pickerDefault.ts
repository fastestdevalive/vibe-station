import type { PickerRowModel } from "./pickerEligibility";

export type PickerDefault =
  /** Wait: the focused agent's row is still settling (capability / readiness probe), so no fallback yet. */
  | { kind: "waiting" }
  | { kind: "row"; id: string }
  | { kind: "none" };

const eligible = (r: PickerRowModel) => !r.disabled && r.target !== "none";

/**
 * Which agent the picker preselects (PRD R61): the agent focused in the agent pane when this scope lists it and it
 * can take comments, else the first eligible row in list order (main first), else nothing. While the focused
 * row is still `pending` the answer is `waiting`, so a quick Enter never lands on a different agent.
 */
export function resolveDefaultRow(rows: readonly PickerRowModel[], focusedId: string | null): PickerDefault {
  const focused = focusedId ? rows.find((r) => r.id === focusedId) : undefined;
  if (focused?.pending) return { kind: "waiting" };
  if (focused && eligible(focused)) return { kind: "row", id: focused.id };
  const first = rows.find(eligible);
  return first ? { kind: "row", id: first.id } : { kind: "none" };
}

/** The enabled rows in order: what arrow keys and Home/End walk over (disabled rows are skipped). */
export function enabledRowIds(rows: readonly PickerRowModel[]): string[] {
  return rows.filter(eligible).map((r) => r.id);
}

/** The next enabled id from `from` in `dir` (wrapping); Home/End are `first` / `last`. */
export function stepRow(ids: readonly string[], from: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const i = from ? ids.indexOf(from) : -1;
  if (i < 0) return dir === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[(i + dir + ids.length) % ids.length]!;
}
