import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  MODES,
  TABLE,
  classify,
  init,
  running,
  timerWanted,
  transition,
  type Effect,
  type EventType,
  type HoldReason,
  type Mode,
  type TrayEvent,
  type TrayState,
  type View,
} from "./trayMode";

const AMB = { viewOpen: false, docHidden: false };
const st = (mode: Mode, over: Partial<TrayState> = {}): TrayState =>
  Object.freeze({ mode, active: false, pinned: false, holds: Object.freeze([]) as readonly HoldReason[], ...over });
const ev = (type: EventType): TrayEvent => {
  if (type === "holdOn" || type === "holdOff") return { type, reason: "hover" };
  if (type === "sessionSwitch") return { type, cls: "finished", pref: "strip", ambient: AMB };
  return { type } as TrayEvent;
};
const kinds = (e: Effect[]) => e.map((x) => x.kind);
const run = (s: TrayState, e: TrayEvent, pref: View = "strip") => transition(s, e, pref);
const START = { kind: "startTimer", ms: 5000 };

// mode x event -> expected next mode for the default state (inactive, unpinned, no holds, pref strip).
const EXPECT: Record<Mode, Partial<Record<EventType, Mode>>> = {
  hidden: { tasksActive: "strip", tasksFinished: "dot", sessionSwitch: "dot" },
  dot: { tasksNone: "hidden", tasksActive: "strip", tapDot: "strip", sessionSwitch: "dot" },
  strip: { tasksNone: "hidden", tapStrip: "bar", timerElapsed: "dot", sessionSwitch: "dot" },
  bar: { tasksNone: "hidden", tapHeader: "strip", userCollapse: "strip", timerElapsed: "dot", sessionSwitch: "dot" },
};

describe("trayMode table", () => {
  it("covers every mode x event pair (52 cells)", () => {
    expect(MODES).toHaveLength(4);
    expect(EVENT_TYPES).toHaveLength(13);
    for (const m of MODES) for (const e of EVENT_TYPES) expect(TABLE[m][e], `${m}/${e}`).toBeDefined();
  });

  const cells = MODES.flatMap((m) => EVENT_TYPES.map((e) => [m, e] as const));
  it.each(cells)("%s + %s", (m, e) => {
    const { state } = run(st(m), ev(e));
    expect(state.mode).toBe(EXPECT[m][e] ?? m);
  });

  it("tasksUnknown is a no-op everywhere (same ref, no effects)", () => {
    for (const m of MODES) {
      const s = st(m, { active: true });
      const r = run(s, { type: "tasksUnknown" });
      expect(r.state).toBe(s);
      expect(r.effects).toEqual([]);
    }
  });

  it("tasksActive sets active and honours pref from hidden/dot", () => {
    expect(run(st("hidden"), { type: "tasksActive" }, "bar").state).toMatchObject({ mode: "bar", active: true, pinned: false });
    expect(run(st("dot"), { type: "tasksActive" }, "bar").state.mode).toBe("bar");
    expect(run(st("strip"), { type: "tasksActive" }).state.active).toBe(true);
  });

  it("tasksFinished sets active=false everywhere without changing strip/bar", () => {
    for (const m of ["dot", "strip", "bar"] as const) {
      expect(run(st(m, { active: true }), { type: "tasksFinished" }).state).toMatchObject({ mode: m, active: false });
    }
  });

  it("timerElapsed guards: strip needs !active, bar needs !active && !pinned", () => {
    expect(run(st("strip", { active: true }), ev("timerElapsed")).state.mode).toBe("strip");
    expect(run(st("bar", { active: true }), ev("timerElapsed")).state.mode).toBe("bar");
    expect(run(st("bar", { pinned: true }), ev("timerElapsed")).state.mode).toBe("bar");
    expect(run(st("bar"), ev("timerElapsed")).state.mode).toBe("dot");
  });

  it("tapHeader / userCollapse from a pinned bar clear pinned", () => {
    expect(run(st("bar", { pinned: true }), ev("tapHeader")).state.pinned).toBe(false);
    expect(run(st("bar", { pinned: true }), ev("userCollapse")).state.pinned).toBe(false);
  });
});

describe("timer derivation", () => {
  it("starts on dot -> strip (tap) and on a calm strip / unpinned bar", () => {
    expect(run(st("dot"), ev("tapDot")).effects).toContainEqual(START);
    expect(run(st("strip", { active: true }), ev("tasksFinished")).effects).toContainEqual(START);
    expect(run(st("bar", { active: true }), ev("tasksFinished")).effects).toContainEqual(START);
  });
  it("never runs while active or pinned", () => {
    expect(running(st("strip", { active: true }))).toBe(false);
    expect(running(st("bar", { pinned: true }))).toBe(false);
    expect(timerWanted(st("bar", { pinned: true }))).toBe(false);
    expect(run(st("bar", { active: true }), ev("tasksFinished")).state.pinned).toBe(false);
    expect(run(st("bar", { pinned: true }), ev("tasksFinished")).effects).toEqual([]);
  });
  it("cancels when a task becomes active during a countdown", () => {
    const tapped = run(st("dot"), ev("tapDot")).state;
    expect(kinds(run(tapped, ev("tasksActive")).effects)).toContain("cancelTimer");
    expect(run(st("strip"), ev("tasksActive")).effects).toEqual([{ kind: "cancelTimer" }]);
    expect(run(st("dot"), ev("tasksActive")).effects).toEqual([{ kind: "restoreFocus" }]);
  });
  it("holdOn cancels, holdOff restarts with a full 5000, poke restarts", () => {
    const tapped = run(st("dot"), ev("tapDot")).state;
    const held = run(tapped, { type: "holdOn", reason: "hover" });
    expect(held.effects).toEqual([{ kind: "cancelTimer" }]);
    expect(run(held.state, { type: "holdOff", reason: "hover" }).effects).toEqual([START]);
    expect(run(tapped, ev("poke")).effects).toEqual([START]);
    expect(run(held.state, ev("poke")).effects).toEqual([]);
  });
  it("two holds: dropping one does not restart", () => {
    const s = st("strip", { holds: ["focus", "hover"] });
    expect(run(s, { type: "holdOff", reason: "hover" }).effects).toEqual([]);
  });
  it("idempotent tasksFinished emits nothing and keeps the ref", () => {
    const s = st("strip");
    const r = run(s, ev("tasksFinished"));
    expect(r.state).toBe(s);
    expect(r.effects).toEqual([]);
  });
  it("no stray cancelTimer when nothing was running", () => {
    expect(run(st("dot"), { type: "holdOn", reason: "hover" }).effects).toEqual([]);
    expect(run(st("strip", { active: true }), { type: "holdOn", reason: "hover" }).effects).toEqual([]);
  });
});

describe("pref writes", () => {
  it("only tapStrip (bar) and tapHeader@bar (strip), only while active", () => {
    expect(run(st("strip", { active: true }), ev("tapStrip")).effects).toContainEqual({ kind: "writePref", view: "bar" });
    expect(run(st("bar", { active: true }), ev("tapHeader")).effects).toContainEqual({ kind: "writePref", view: "strip" });
    expect(kinds(run(st("strip"), ev("tapStrip")).effects)).not.toContain("writePref");
    expect(kinds(run(st("bar"), ev("tapHeader")).effects)).not.toContain("writePref");
  });
  it("never from any other event in any mode", () => {
    const others = EVENT_TYPES.filter((t) => t !== "tapStrip" && t !== "tapHeader");
    for (const m of MODES)
      for (const t of others) {
        for (const active of [true, false]) {
          expect(kinds(run(st(m, { active }), ev(t)).effects), `${m}/${t}`).not.toContain("writePref");
        }
      }
  });
});

describe("init / classify / sessionSwitch", () => {
  it("classify", () => {
    expect(classify(0, 0)).toBe("none");
    expect(classify(3, 0)).toBe("finished");
    expect(classify(3, 1)).toBe("active");
  });
  const amb = [
    { viewOpen: false, docHidden: false },
    { viewOpen: true, docHidden: false },
    { viewOpen: false, docHidden: true },
    { viewOpen: true, docHidden: true },
  ];
  it.each(amb)("init seeds holds from ambient %o", (a) => {
    const expected = [...(a.docHidden ? ["hidden"] : []), ...(a.viewOpen ? ["view"] : [])];
    for (const pref of ["strip", "bar"] as const) {
      expect(init("active", pref, a)).toMatchObject({ mode: pref === "bar" ? "bar" : "strip", active: true, pinned: false, holds: expected });
      expect(init("finished", pref, a)).toMatchObject({ mode: "dot", active: false, holds: expected });
      expect(init("none", pref, a)).toMatchObject({ mode: "hidden", holds: [] });
      expect(init(undefined, pref, a)).toMatchObject({ mode: "hidden", holds: [] });
    }
  });
  it("sessionSwitch clears holds/pinned, cancels, then re-seeds without mutation", () => {
    const s = st("bar", { pinned: true, holds: ["hover"] });
    const r = run(s, { type: "sessionSwitch", cls: "finished", pref: "strip", ambient: { viewOpen: true, docHidden: false } });
    expect(r.state).toEqual({ mode: "dot", active: false, pinned: false, holds: ["view"] });
    expect(r.effects[0]).toEqual({ kind: "cancelTimer" });
    const calm = run(s, { type: "sessionSwitch", cls: "active", pref: "bar", ambient: AMB });
    expect(calm.state.mode).toBe("bar");
    expect(kinds(calm.effects)).not.toContain("startTimer");
  });
  it("tasksNone clears holds and pinned", () => {
    const r = run(st("bar", { pinned: true, holds: ["hover"] }), ev("tasksNone"));
    expect(r.state).toEqual({ mode: "hidden", active: false, pinned: false, holds: [] });
  });
});

describe("holds", () => {
  it("holdOn(view) removes hover and focus; holdOff(view) restarts the timer", () => {
    const s = st("strip", { holds: ["focus", "hover"] });
    const on = run(s, { type: "holdOn", reason: "view" });
    expect(on.state.holds).toEqual(["view"]);
    expect(run(on.state, { type: "holdOff", reason: "view" }).effects).toEqual([START]);
  });
  it("hold events are ignored while hidden", () => {
    const s = st("hidden");
    expect(run(s, { type: "holdOn", reason: "hover" }).state).toBe(s);
  });
});

describe("calm timer flows", () => {
  it("pref-opened unpinned bar + tasksFinished -> timer -> dot; tapStrip-pinned stays", () => {
    const bar = init("active", "bar", AMB);
    const fin = run(bar, { type: "tasksFinished" });
    expect(fin.effects).toContainEqual(START);
    expect(run(fin.state, { type: "timerElapsed" }).state.mode).toBe("dot");
    const pinned = run(st("strip", { active: true }), { type: "tapStrip" }).state;
    const fin2 = run(pinned, { type: "tasksFinished" });
    expect(fin2.effects).toEqual([]);
    expect(run(fin2.state, { type: "timerElapsed" }).state.mode).toBe("bar");
  });
  it("collapsing an unpinned finished bar to strip restarts the calm timer", () => {
    const r = run(st("bar"), ev("userCollapse"));
    expect(r.effects).toContainEqual(START);
  });
});
