import { describe, expect, it } from "vitest";
import type { PickerRowModel } from "./pickerEligibility";
import { enabledRowIds, resolveDefaultRow, stepRow } from "./pickerDefault";

const row = (id: string, over: Partial<PickerRowModel> = {}): PickerRowModel => ({
  id,
  name: id,
  chip: "Rich Chat",
  target: "rich",
  state: "idle",
  why: "idle",
  warn: false,
  disabled: false,
  canSend: true,
  canAttach: true,
  canSchedule: true,
  ...over,
});
const off = (id: string, over: Partial<PickerRowModel> = {}) => row(id, { disabled: true, target: "none", canSend: false, canAttach: false, canSchedule: false, ...over });

describe("resolveDefaultRow", () => {
  const rows = [row("main"), row("b"), row("c")];
  it("the focused eligible agent wins", () => {
    expect(resolveDefaultRow(rows, "b")).toEqual({ kind: "row", id: "b" });
  });
  it("an ineligible focus falls to the first eligible row in list order", () => {
    expect(resolveDefaultRow([off("x"), row("main"), row("b")], "x")).toEqual({ kind: "row", id: "main" });
  });
  it("a focus outside the scope's rows, or none, falls to the first eligible row", () => {
    expect(resolveDefaultRow(rows, "elsewhere")).toEqual({ kind: "row", id: "main" });
    expect(resolveDefaultRow(rows, null)).toEqual({ kind: "row", id: "main" });
  });
  it("waits while the focused row is still pending, instead of falling through", () => {
    expect(resolveDefaultRow([row("main"), off("t", { pending: true })], "t")).toEqual({ kind: "waiting" });
    expect(resolveDefaultRow([row("main"), row("t", { target: "terminal", pending: true })], "t")).toEqual({ kind: "waiting" });
  });
  it("a pending row that is not the focused one does not hold the default", () => {
    expect(resolveDefaultRow([row("main"), off("t", { pending: true })], null)).toEqual({ kind: "row", id: "main" });
  });
  it("nothing eligible gives none", () => {
    expect(resolveDefaultRow([off("a"), off("b")], "a")).toEqual({ kind: "none" });
    expect(resolveDefaultRow([], null)).toEqual({ kind: "none" });
  });
});

describe("stepRow / enabledRowIds", () => {
  const rows = [row("a"), off("x"), row("b"), row("c")];
  it("lists only enabled rows", () => {
    expect(enabledRowIds(rows)).toEqual(["a", "b", "c"]);
  });
  it("steps over enabled rows and wraps", () => {
    const ids = enabledRowIds(rows);
    expect(stepRow(ids, "a", 1)).toBe("b");
    expect(stepRow(ids, "c", 1)).toBe("a");
    expect(stepRow(ids, "a", -1)).toBe("c");
    expect(stepRow(ids, null, 1)).toBe("a");
    expect(stepRow(ids, null, -1)).toBe("c");
    expect(stepRow([], "a", 1)).toBeNull();
  });
});
