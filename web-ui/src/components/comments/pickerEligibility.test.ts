import { describe, expect, it } from "vitest";
import type { Session, SessionState } from "@/api/types";
import { buildPickerRow, wantsReadiness } from "./pickerEligibility";

const session = (over: Partial<Session> = {}): Session =>
  ({
    id: "s1",
    worktreeId: "wt-1",
    projectId: "p1",
    modeId: "m1",
    type: "agent",
    name: "main",
    isMain: true,
    state: "idle",
    lifecycleState: "drafting",
    tmuxName: "t",
    channel: "json",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  }) as Session;

const row = (state: SessionState, over: Partial<Session> = {}, extra: Partial<Parameters<typeof buildPickerRow>[0]> = {}) =>
  buildPickerRow({ session: session(over), state, supportsTerminalComments: true, modeMissing: false, ...extra });

describe("picker eligibility: Rich Chat (6.T3)", () => {
  it.each([
    ["idle", "idle", false],
    ["working", "working · queues", false],
    ["not_started", "starting · queues", false],
    ["waiting_for_human", "needs you · queues", false],
    ["exited", "exited · resumes on send", false],
    ["done", "marked done · sends with warning", true],
  ] as const)("%s sends, attaches and schedules: %s", (state, why, warn) => {
    const r = row(state);
    expect(r).toMatchObject({ chip: "Rich Chat", target: "rich", why, warn, disabled: false, canSend: true, canAttach: true, canSchedule: true });
  });

  it("drafting is a disabled Draft row, whatever the channel", () => {
    expect(row("drafting")).toMatchObject({ chip: "Draft", disabled: true, canSend: false, canAttach: false, canSchedule: false, why: "drafting · not started" });
  });

  it("resolves the state it is given (the live map), never the record's lifecycleState", () => {
    // lifecycleState is frozen at "drafting" on the record; the live state decides.
    expect(row("working", { lifecycleState: "drafting" }).canSend).toBe(true);
  });
});

describe("picker eligibility: Terminal", () => {
  const tmux = { channel: "tmux" as const, name: "Agent 1", isMain: false };

  it("ready (probe) / idle / working rows can send and schedule, but not attach", () => {
    expect(row("idle", tmux, { readiness: "ready" })).toMatchObject({ chip: "Terminal", why: "ready", canSend: true, canSchedule: true, canAttach: false, disabled: false });
    expect(row("idle", tmux, { readiness: "unknown" }).why).toBe("idle");
    expect(row("idle", tmux).why).toBe("idle");
    expect(row("working", tmux).why).toBe("working · waits for ready");
    expect(row("not_started", tmux).why).toBe("working · waits for ready");
  });

  it("an idle Terminal agent (waiting_for_human) is selectable only once the probe says ready", () => {
    const ready = row("waiting_for_human", tmux, { readiness: "ready" });
    expect(ready).toMatchObject({ disabled: false, target: "terminal", why: "ready", canSend: true });
    expect(ready.pending).toBeUndefined();
    const pending = row("waiting_for_human", tmux, { readinessPending: true });
    expect(pending).toMatchObject({ disabled: true, pending: true, probe: true });
    expect(wantsReadiness(pending)).toBe(true);
  });

  it("is disabled with the reason for awaiting approval, exited, done, pty, missing mode, unsupported CLI", () => {
    expect(row("waiting_for_human", tmux)).toMatchObject({ disabled: true, why: "awaiting approval / unknown", canSend: false });
    expect(row("waiting_for_human", tmux, { readiness: "awaiting_approval" })).toMatchObject({ disabled: true, why: "awaiting approval" });
    expect(row("idle", tmux, { readiness: "awaiting_approval" })).toMatchObject({ disabled: true, why: "awaiting approval" });
    expect(row("exited", tmux)).toMatchObject({ disabled: true, why: "exited" });
    expect(row("done", tmux)).toMatchObject({ disabled: true, why: "marked done" });
    expect(row("idle", { ...tmux, channel: "pty" })).toMatchObject({ chip: "Terminal (pty)", disabled: true, why: "not supported" });
    expect(row("idle", tmux, { modeMissing: true })).toMatchObject({ disabled: true, why: "mode no longer exists" });
    // supportsTerminalComments false = the CLI's paste is not multi-line safe (!multiline_ok)
    expect(row("idle", tmux, { supportsTerminalComments: false })).toMatchObject({ disabled: true, why: "not supported" });
    expect(row("idle", tmux, { supportsTerminalComments: undefined })).toMatchObject({ disabled: true, why: "checking support…" });
  });

  it("only enabled Terminal rows are probed for readiness", () => {
    expect(wantsReadiness(row("idle", tmux))).toBe(true);
    expect(wantsReadiness(row("exited", tmux))).toBe(false);
    expect(wantsReadiness(row("idle"))).toBe(false);
  });
});
