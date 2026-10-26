import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { usePaneDialogs } from "@/hooks/usePaneDialogs";
import { PaneDialogHost } from "./PaneDialogHost";

const api = {
  resetSession: vi.fn(),
  cancelReset: vi.fn(),
  listModes: vi.fn().mockResolvedValue([]),
  getSupportedClis: vi.fn().mockResolvedValue([]),
} as unknown as ApiInstance;

const session = { id: "s1", modeId: "m-claude", channel: "json", type: "agent" } as Session;

describe("PaneDialogHost cancel/failed-summary notice", () => {
  beforeEach(() => usePaneDialogs.getState()._reset());
  afterEach(() => usePaneDialogs.getState()._reset());

  it("a failed Start fresh offers Transcript, Nothing and Dismiss", () => {
    usePaneDialogs.getState().setNotice({
      sessionId: "s1",
      text: "Summary was not written.",
      options: { carryOver: "summary" },
    });
    render(<PaneDialogHost api={api} sessionId="s1" session={session} />);
    expect(screen.getByRole("dialog", { name: "Couldn't start fresh" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start fresh with Transcript" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start fresh with Nothing" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("a failed Switch says switch and never offers Nothing", () => {
    usePaneDialogs.getState().setNotice({
      sessionId: "s1",
      text: "Summary was not written.",
      options: { carryOver: "summary", modeId: "m-sonnet" },
    });
    render(<PaneDialogHost api={api} sessionId="s1" session={session} />);
    expect(screen.getByRole("dialog", { name: "Couldn't switch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch with Transcript" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Nothing/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});
