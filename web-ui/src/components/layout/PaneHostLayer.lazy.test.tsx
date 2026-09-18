import { render } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { PaneOutlet, PaneOutletProvider } from "./paneOutlets";
import { PaneHostLayer, type PaneKey } from "./PaneHostLayer";

/**
 * Lazy pane mounting (worktree-switch-latency item 5b).
 *
 * `PaneHostLayer` used to mount every candidate pane for the active worktree in
 * one render pass on a worktree switch, firing N+M concurrent
 * `session:open`/`chat:open` calls regardless of which pane was actually
 * visible. It now mounts the union of (a) keys a live `<PaneOutlet>` currently
 * claims and (b) keys mounted before — so claiming an outlet IS the mount
 * trigger, and the pane the user clicked into is the only one that opens.
 *
 * WHAT THESE TESTS ASSERT ON. The thing item 5b changes is the *mount decision*
 * — which keys `PaneHostLayer` renders at all — so that is what is asserted,
 * via the `renderPane` calls it makes. Deliberately NOT asserted: that a pane's
 * mount effect runs exactly once across an outlet swap. React re-creates a
 * portal's children when its container node changes (`updatePortal` compares
 * `containerInfo`), so moving a pane between its outlet and the offscreen
 * holder already remounted it before this change and still does — the
 * separately-tracked "terminal re-inits on remount" bug
 * (`.feature-plans/pending/terminal-remount-and-tmux-leak-fixes.md`, "Fix C —
 * stopping the remount entirely (Layout refactor). Tracked as a follow-up").
 * Lazy mounting neither causes nor worsens it; it strictly reduces the number
 * of panes exposed to it. What IS asserted per pane is that exactly one live
 * instance survives — a second one would be the duplicate-stream/double-echo
 * class of bug.
 */

/** Keys `PaneHostLayer` asked to render, per render pass (latest last). */
let renderPasses: PaneKey[][] = [];
/** Every key that has EVER been in the mount set, in first-mount order. */
const everMounted: PaneKey[] = [];
/** Live `FakePane` instances per key — >1 is a duplicate stream. */
const live = new Map<string, number>();
/** Keystrokes each pane accepted — stands in for `session:input`. */
const inputs: Record<string, string[]> = {};

function FakePane({ paneKey }: { paneKey: PaneKey }) {
  useEffect(() => {
    live.set(paneKey, (live.get(paneKey) ?? 0) + 1);
    (inputs[paneKey] ??= []).push("typed");
    return () => {
      live.set(paneKey, (live.get(paneKey) ?? 0) - 1);
    };
  }, [paneKey]);
  return <div data-testid={`pane-${paneKey}`} />;
}

function recordingRenderPane(pass: PaneKey[]) {
  return (key: PaneKey) => {
    pass.push(key);
    if (!everMounted.includes(key)) everMounted.push(key);
    return <FakePane paneKey={key} />;
  };
}

function Harness({
  candidates,
  visible,
}: {
  /** What `Workspace.tsx` passes as `paneKeys` — every eligible pane. */
  candidates: PaneKey[];
  /** Which keys currently have a visible outlet (a tab, or N canvas tiles). */
  visible: PaneKey[];
}) {
  const pass: PaneKey[] = [];
  renderPasses.push(pass);
  return (
    <PaneOutletProvider>
      <PaneHostLayer paneKeys={candidates} renderPane={recordingRenderPane(pass)} />
      {visible.map((k) => (
        <PaneOutlet key={k} paneKey={k} />
      ))}
    </PaneOutletProvider>
  );
}

/**
 * The keys mounted as of the latest `Harness` render.
 *
 * `PaneHostLayer` can re-render on its own (a claimed-key change re-renders it
 * without re-rendering `Harness`), and those passes append to the same array —
 * which is what we want: within one candidate set, mounting is sticky, so the
 * union across that epoch IS the current mount set. A candidate-set change
 * always comes with a fresh `Harness` render, hence a fresh array.
 */
function mountSet(): string[] {
  const pass = renderPasses[renderPasses.length - 1] ?? [];
  return Array.from(new Set(pass)).sort();
}

const WORKTREE_CANDIDATES: PaneKey[] = [
  "agent:a1",
  "agent:a2",
  "terminal:t1",
  "terminal:t2",
  "tools:w1",
];

beforeEach(() => {
  renderPasses = [];
  everMounted.length = 0;
  live.clear();
  for (const k of Object.keys(inputs)) delete inputs[k];
});

describe("PaneHostLayer lazy mounting", () => {
  it("mounts exactly one pane — the claimed key — and opens nothing else", () => {
    // Assertion 1. The worktree has 5 candidate panes; only the active tab's
    // outlet is mounted, so only that one pane may mount and open a stream.
    const { queryByTestId } = render(
      <Harness candidates={WORKTREE_CANDIDATES} visible={["terminal:t1"]} />,
    );

    expect(mountSet()).toEqual(["terminal:t1"]);
    expect(everMounted).toEqual(["terminal:t1"]);
    expect(live.get("terminal:t1")).toBe(1);
    expect(queryByTestId("pane-terminal:t1")).not.toBeNull();
    expect(queryByTestId("pane-agent:a1")).toBeNull();
    expect(queryByTestId("pane-tools:w1")).toBeNull();
  });

  it("keeps a pane in the mount set when its tab is left and returned to (sticky)", () => {
    // Assertion 2. Tab away and back: the pane must never drop out of the
    // mount set — laziness is additive, not eviction. If it were evicted, the
    // return trip would pay a second cold open (and the away trip would have
    // torn down a live PTY stream).
    const { rerender } = render(
      <Harness candidates={WORKTREE_CANDIDATES} visible={["terminal:t1"]} />,
    );
    expect(mountSet()).toEqual(["terminal:t1"]);

    rerender(<Harness candidates={WORKTREE_CANDIDATES} visible={["agent:a1"]} />);
    expect(mountSet()).toEqual(["agent:a1", "terminal:t1"]);

    rerender(<Harness candidates={WORKTREE_CANDIDATES} visible={["terminal:t1"]} />);
    expect(mountSet()).toEqual(["agent:a1", "terminal:t1"]);

    // Only the two visited keys were ever mounted; the other three candidates
    // were never opened at all.
    expect(everMounted.slice().sort()).toEqual(["agent:a1", "terminal:t1"]);
    expect(live.get("terminal:t1")).toBe(1);
    expect(live.get("agent:a1")).toBe(1);
  });

  it("mounts N panes in canvas/workspace-tiled mode, not 1", () => {
    // Assertion 3. Canvas mode renders one `<PaneOutlet>` per tile, and every
    // tile is legitimately visible at once — "mount only the active tab" would
    // leave every tile but one blank. The outlet-claim design handles this for
    // free, because claiming is per outlet, not per active tab.
    const tiles: PaneKey[] = ["agent:a1", "terminal:t1", "tools:w1"];
    const { queryByTestId } = render(
      <Harness candidates={WORKTREE_CANDIDATES} visible={tiles} />,
    );

    expect(mountSet()).toEqual(tiles.slice().sort());
    for (const k of tiles) {
      expect(live.get(k)).toBe(1);
      expect(queryByTestId(`pane-${k}`)).not.toBeNull();
    }
    // The two candidates with no tile stay unmounted.
    expect(queryByTestId("pane-agent:a2")).toBeNull();
    expect(queryByTestId("pane-terminal:t2")).toBeNull();
  });

  it("mounts a deep-link-selected, never-visited session once its state arrives", () => {
    // Assertion 4. A deep link can select a session before its record has
    // arrived from the daemon, so the key is not yet a candidate — only its
    // outlet is mounted. When the session record lands (candidates grow), the
    // already-claimed outlet must mount the pane immediately, with no second
    // user action. This is the item-5a interaction: session state arriving
    // after the outlet was claimed.
    const { rerender, queryByTestId } = render(
      <Harness candidates={[]} visible={["agent:deep1"]} />,
    );
    expect(mountSet()).toEqual([]);
    expect(queryByTestId("pane-agent:deep1")).toBeNull();

    rerender(<Harness candidates={["agent:deep1"]} visible={["agent:deep1"]} />);

    expect(mountSet()).toEqual(["agent:deep1"]);
    expect(live.get("agent:deep1")).toBe(1);
    expect(queryByTestId("pane-agent:deep1")).not.toBeNull();
  });

  it("survives rapid mashing between two never-visited tabs with no duplicate stream or lost input", () => {
    // Assertion 5. Each switch is its own commit, so outlet claims race with
    // the mounts they trigger. No pane may end up with two live instances (a
    // duplicate stream = double echo), none may be dropped from the mount set,
    // and none may lose the input it recorded on mount.
    const { rerender } = render(
      <Harness candidates={WORKTREE_CANDIDATES} visible={["terminal:t1"]} />,
    );

    // Each switch flushes on its own (testing-library's `rerender` acts), so
    // every claim/unclaim really happens — batching them into one commit would
    // collapse the mash into a single switch and test nothing.
    for (let i = 0; i < 12; i++) {
      rerender(
        <Harness
          candidates={WORKTREE_CANDIDATES}
          visible={[i % 2 === 0 ? "terminal:t2" : "agent:a2"]}
        />,
      );
    }

    expect(mountSet()).toEqual(["agent:a2", "terminal:t1", "terminal:t2"]);
    for (const k of ["terminal:t1", "terminal:t2", "agent:a2"]) {
      expect(live.get(k)).toBe(1);
      expect(inputs[k]?.length ?? 0).toBeGreaterThan(0);
    }
    // The two candidates never visited are still untouched.
    expect(everMounted).not.toContain("agent:a1");
    expect(everMounted).not.toContain("tools:w1");
  });

  it("unmounts panes that leave the candidate set, as before (worktree switch)", () => {
    // Laziness is additive, not eviction — but leaving the candidate set (the
    // user switched worktrees) must still unmount, exactly as it always did.
    const { rerender } = render(
      <Harness candidates={WORKTREE_CANDIDATES} visible={["terminal:t1"]} />,
    );
    expect(live.get("terminal:t1")).toBe(1);

    rerender(<Harness candidates={["agent:b1", "tools:w2"]} visible={["agent:b1"]} />);

    expect(mountSet()).toEqual(["agent:b1"]);
    expect(live.get("terminal:t1")).toBe(0);
    expect(live.get("agent:b1")).toBe(1);

    // Switching back does NOT resurrect the old pane until something claims it
    // again: the sticky set is pruned to the current candidates, so a worktree
    // switch can never silently re-open a whole worktree's panes.
    rerender(<Harness candidates={WORKTREE_CANDIDATES} visible={[]} />);
    expect(mountSet()).toEqual([]);
  });
});
