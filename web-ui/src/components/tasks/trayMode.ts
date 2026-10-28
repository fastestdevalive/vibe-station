/**
 * Pure state map for the task tray's views (no timers, no DOM, no React). `useTrayMode` owns the single
 * `setTimeout` and feeds events in; this module only answers "given state + event, what is the next state
 * and which effects must the caller run". See `.vibekit/feature-plans/wip/tray-collapse/` (State model).
 */

export type Mode = "hidden" | "dot" | "strip" | "bar";
/** Stored preference values: "0"/absent = strip, "1" = bar. */
export type View = "strip" | "bar";
export type HoldReason = "hover" | "focus" | "view" | "hidden";
export type TaskClass = "none" | "active" | "finished";

export interface TrayState {
  mode: Mode;
  /** At least one task is running (quiet included). */
  active: boolean;
  /** Set by `tapStrip` (the user opened the bar): it never auto-collapses until the user collapses it. */
  pinned: boolean;
  /** Sorted, unique. Holds suppress the timer only; they never change the mode. */
  holds: readonly HoldReason[];
}
export interface Ambient {
  viewOpen: boolean;
  docHidden: boolean;
}

export type TrayEvent =
  | { type: "tasksUnknown" }
  | { type: "tasksNone" }
  | { type: "tasksActive" }
  | { type: "tasksFinished" }
  | { type: "tapDot" }
  | { type: "tapStrip" }
  | { type: "tapHeader" }
  | { type: "userCollapse" }
  | { type: "timerElapsed" }
  | { type: "poke" }
  | { type: "holdOn"; reason: HoldReason }
  | { type: "holdOff"; reason: HoldReason }
  | { type: "sessionSwitch"; cls: TaskClass | undefined; pref: View; ambient: Ambient };
export type EventType = TrayEvent["type"];

export type Effect =
  | { kind: "startTimer"; ms: 5000 }
  | { kind: "cancelTimer" }
  | { kind: "writePref"; view: View }
  | { kind: "restoreFocus" };

export const TIMER_MS = 5000;

export const MODES: readonly Mode[] = ["hidden", "dot", "strip", "bar"];
export const EVENT_TYPES: readonly EventType[] = [
  "tasksUnknown",
  "tasksNone",
  "tasksActive",
  "tasksFinished",
  "tapDot",
  "tapStrip",
  "tapHeader",
  "userCollapse",
  "timerElapsed",
  "poke",
  "holdOn",
  "holdOff",
  "sessionSwitch",
];

type Next = Mode | "stay" | "byPref" | "init";
export interface Cell {
  next: Next;
  /** Sets `state.active` (tasks events only). */
  active?: boolean;
  pinned?: boolean;
  /** Emit `writePref` for the new mode, only while the NEW state is active. */
  writePref?: boolean;
  /** Guard evaluated on the previous state; a failed guard degrades the cell to `stay`. */
  when?: "inactive" | "inactiveUnpinned";
}

const STAY: Cell = { next: "stay" };
const row = (c: Partial<Record<EventType, Cell>>): Record<EventType, Cell> => ({
  tasksUnknown: STAY,
  tasksNone: STAY,
  tasksActive: STAY,
  tasksFinished: STAY,
  tapDot: STAY,
  tapStrip: STAY,
  tapHeader: STAY,
  userCollapse: STAY,
  timerElapsed: STAY,
  poke: STAY,
  holdOn: STAY,
  holdOff: STAY,
  sessionSwitch: { next: "init" },
  ...c,
});

const TO_HIDDEN: Cell = { next: "hidden" };
const ACTIVE_BY_PREF: Cell = { next: "byPref", active: true };

export const TABLE: Record<Mode, Record<EventType, Cell>> = {
  hidden: row({ tasksActive: ACTIVE_BY_PREF, tasksFinished: { next: "dot", active: false } }),
  dot: row({
    tasksNone: TO_HIDDEN,
    tasksActive: ACTIVE_BY_PREF,
    tasksFinished: { next: "stay", active: false },
    // Dot -> strip (never straight to the bar); the strip's calm timer returns it to the dot if left alone.
    tapDot: { next: "strip" },
  }),
  strip: row({
    tasksNone: TO_HIDDEN,
    tasksActive: { next: "stay", active: true },
    tasksFinished: { next: "stay", active: false },
    tapStrip: { next: "bar", pinned: true, writePref: true },
    timerElapsed: { next: "dot", when: "inactive" },
  }),
  bar: row({
    tasksNone: TO_HIDDEN,
    tasksActive: { next: "stay", active: true },
    tasksFinished: { next: "stay", active: false },
    tapHeader: { next: "strip", pinned: false, writePref: true },
    userCollapse: { next: "strip", pinned: false },
    timerElapsed: { next: "dot", when: "inactiveUnpinned" },
  }),
};

const HOLD_ORDER: readonly HoldReason[] = ["focus", "hidden", "hover", "view"];
const sortHolds = (h: Iterable<HoldReason>): HoldReason[] => {
  const set = new Set(h);
  return HOLD_ORDER.filter((r) => set.has(r));
};

function seedHolds(a: Ambient): HoldReason[] {
  return sortHolds([...(a.viewOpen ? (["view"] as const) : []), ...(a.docHidden ? (["hidden"] as const) : [])]);
}

export function classify(total: number, liveCount: number): TaskClass {
  if (total === 0) return "none";
  return liveCount > 0 ? "active" : "finished";
}

export function init(cls: TaskClass | undefined, pref: View, ambient: Ambient): TrayState {
  if (cls === undefined || cls === "none") return { mode: "hidden", active: false, pinned: false, holds: [] };
  const mode: Mode = cls === "finished" ? "dot" : pref === "bar" ? "bar" : "strip";
  return { mode, active: cls === "active", pinned: false, holds: seedHolds(ambient) };
}

export function timerWanted(s: TrayState): boolean {
  return (s.mode === "strip" || s.mode === "bar") && !s.active && !s.pinned;
}
export function running(s: TrayState): boolean {
  return timerWanted(s) && s.holds.length === 0;
}

const sameHolds = (a: readonly HoldReason[], b: readonly HoldReason[]) => a.length === b.length && a.every((r, i) => r === b[i]);

function applyHold(s: TrayState, e: Extract<TrayEvent, { type: "holdOn" | "holdOff" }>): readonly HoldReason[] {
  if (s.mode === "hidden") return s.holds;
  const set = new Set(s.holds);
  if (e.type === "holdOff") set.delete(e.reason);
  else {
    set.add(e.reason);
    if (e.reason === "view") {
      set.delete("hover");
      set.delete("focus");
    }
  }
  return sortHolds(set);
}

export function transition(s: TrayState, e: TrayEvent, pref: View): { state: TrayState; effects: Effect[] } {
  const effects: Effect[] = [];
  let next: TrayState;

  if (e.type === "sessionSwitch") {
    next = init(e.cls, e.pref, e.ambient);
    effects.push({ kind: "cancelTimer" });
  } else if (e.type === "holdOn" || e.type === "holdOff") {
    next = { ...s, holds: applyHold(s, e) };
  } else {
    const cell = TABLE[s.mode][e.type];
    const guardOk =
      cell.when === undefined ||
      (cell.when === "inactive" ? !s.active : !s.active && !s.pinned);
    const target: Next = guardOk ? cell.next : "stay";
    const mode: Mode = target === "stay" ? s.mode : target === "byPref" ? (pref === "bar" ? "bar" : "strip") : (target as Mode);
    let pinned = s.pinned;
    if (guardOk && cell.pinned !== undefined) pinned = cell.pinned;
    if (mode !== "bar") pinned = false;
    next = {
      mode,
      active: cell.active ?? s.active,
      pinned,
      holds: mode === "hidden" ? [] : s.holds,
    };
    if (guardOk && cell.writePref && next.active) effects.push({ kind: "writePref", view: mode === "strip" ? "strip" : "bar" });
  }

  const unchanged = next.mode === s.mode && next.active === s.active && next.pinned === s.pinned && sameHolds(next.holds, s.holds);
  if (unchanged && e.type !== "sessionSwitch") next = s;
  if (next.mode !== s.mode) effects.push({ kind: "restoreFocus" });

  const prevRunning = e.type === "sessionSwitch" ? false : running(s);
  const nextRunning = running(next);
  if (nextRunning && (!prevRunning || e.type === "poke" || next.mode !== s.mode)) effects.push({ kind: "startTimer", ms: TIMER_MS });
  else if (prevRunning && !nextRunning) effects.push({ kind: "cancelTimer" });

  return { state: next, effects };
}
