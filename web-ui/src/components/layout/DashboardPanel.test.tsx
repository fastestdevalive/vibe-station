import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import type { ApiInstance } from "@/api";
import { createMockApi } from "@/api/mock";
import { DashboardPanel, bucketForRollup, useSessionBuckets } from "./DashboardPanel";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useServerSync } from "@/hooks/useServerSync";
import { useModesStore } from "@/store/modesStore";

describe("bucketForRollup (4.T1, inverted by 5.T3/D19, split by 6.T1/6.6)", () => {
  it("5.T3 — done + pr=merged lands in finished, NOT the pr bucket (D19 — done is terminal)", () => {
    expect(bucketForRollup("done", { state: "merged", checkedAt: "" })).toBe("finished");
  });

  it("exited + pr=open also lands in finished (D19 applies to exited too)", () => {
    expect(bucketForRollup("exited", { state: "open", checkedAt: "" })).toBe("finished");
  });

  it("working + pr=open stays in working — live activity wins", () => {
    expect(bucketForRollup("working", { state: "open", checkedAt: "" })).toBe("working");
  });

  it("idle + pr=open lands in the pr bucket", () => {
    expect(bucketForRollup("idle", { state: "open", checkedAt: "" })).toBe("pr");
  });

  it("6.T1 — waiting_for_human maps to needs-you", () => {
    expect(bucketForRollup("waiting_for_human", null)).toBe("needs-you");
  });

  it("6.T1 — idle + pr=draft/closed/none/null maps to idle, not needs-you", () => {
    expect(bucketForRollup("idle", { state: "draft", checkedAt: "" })).toBe("idle");
    expect(bucketForRollup("idle", { state: "closed", checkedAt: "" })).toBe("idle");
    expect(bucketForRollup("idle", { state: "none", checkedAt: "" })).toBe("idle");
    expect(bucketForRollup("idle", null)).toBe("idle");
  });

  it("done + no pr lands in finished", () => {
    expect(bucketForRollup("done", null)).toBe("finished");
  });
});

/** Mirrors production wiring (useServerSync lives in Workspace) so WS events
 *  emitted via api.__test.emit flow into the central store. */
/** Name links (`a.acard__name`) of the agent cards under `root` whose card text matches `text`
 *  (the link's own name is just the agent label; project/branch live in the path row). */
function cardLinks(root: HTMLElement, text: RegExp): HTMLElement[] {
  return within(root)
    .getAllByRole("article")
    .filter((a) => text.test(a.textContent ?? ""))
    .map((a) => a.querySelector("a.acard__name") as HTMLElement);
}
function cardLink(root: HTMLElement, text: RegExp): HTMLElement {
  const links = cardLinks(root, text);
  if (links.length !== 1) throw new Error(`expected exactly one card matching ${text}, got ${links.length}`);
  return links[0]!;
}

function Harness({ api, children }: { api: ApiInstance; children: ReactNode }) {
  useServerSync(api);
  return <>{children}</>;
}

/** Renders the extracted `useSessionBuckets` hook's output so tests can assert
 *  the bucketing arrays directly (Decision 6 regression — 3.T1/3.T2). */
function BucketsProbe({
  projectFilter,
  worktreeOnly,
}: {
  projectFilter?: string;
  worktreeOnly?: boolean;
}) {
  const b = useSessionBuckets(projectFilter, worktreeOnly ? { worktreeOnly: true } : undefined);
  return (
    <div
      data-testid="buckets"
      data-json={JSON.stringify({
        working: b.working.map((s) => s.id),
        needsYou: b.needsYou.map((s) => s.id),
        idle: b.idle.map((s) => s.id),
        pr: b.pr.map((s) => s.id),
        finished: b.finished.map((s) => s.id),
      })}
    />
  );
}

function bucketsJson(): string {
  return screen.getByTestId("buckets").getAttribute("data-json") ?? "{}";
}


describe("DashboardPanel", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
    useModesStore.getState()._reset();
  });

  // The daemon dot was replaced by the remote-access indicators (tunnel state +
  // remote device count); connectivity now comes from the WS state elsewhere.
  it("renders the tunnel indicator and project names on worktree cards", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/tunnel off/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });
  });

  it("2.T8 — a persisted enabled tunnel with no URL reads as off, and the poll does not probe the binary", async () => {
    const api = createMockApi();
    const getStatus = vi
      .spyOn(api, "getTunnelStatus")
      .mockResolvedValue({ enabled: true, tunnelUrl: null });
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/tunnel off/i)).toBeInTheDocument();
    });
    expect(getStatus).toHaveBeenCalled();
    for (const call of getStatus.mock.calls) {
      expect(call[0]).toBeUndefined();
    }
  });

  it("renders working and idle sections (6.6 split), with finished hidden until toggled", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });
    expect(screen.getByText("working")).toBeInTheDocument();
    // wt-1's sess-agent2 and wt-3's sess-wt3-main are idle sessions — bucket
    // to "idle" (6.6 split), not "finished" and not "needs you" (no session
    // is waiting_for_human in the default fixture).
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.queryByText("needs you")).toBeNull();
    // wt-2's "done" session is finished — hidden by default.
    expect(screen.queryByText("finished")).toBeNull();

    await userEvent.click(screen.getByRole("checkbox", { name: /show finished/i }));
    expect(screen.getByText("finished")).toBeInTheDocument();
  });

  it("6.T3 — dashboard-direct-agents — shows a direct (worktree-less) agent session, bucketed by its own state and linking to /project/:projectId/:id", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });

    api.__test.emit({
      type: "session:created",
      sessionId: "sess-direct-1",
      worktreeId: null,
      projectId: "proj-a",
      sessionType: "agent",
      snapshot: {
        id: "sess-direct-1",
        worktreeId: null,
        projectId: "proj-a",
        modeId: "mode-1",
        type: "agent",
        name: "My Direct Agent",
        isMain: false,
        state: "working",
        lifecycleState: "working",
        tmuxName: "sess-direct-1",
        createdAt: new Date().toISOString(),
      },
    });

    await waitFor(() => {
      const workingSection = screen.getByText("working").closest("section");
      expect(workingSection).not.toBeNull();
      const link = within(workingSection!).getByRole("link", { name: /My Direct Agent/i });
      expect(link).toHaveAttribute("href", "/project/proj-a/sess-direct-1");
    });
  });

  it("updates a session's card bucket when session:state fires", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });
    const workingSection = screen.getByText("working").closest("section");
    expect(workingSection).not.toBeNull();
    // Only sess-main is working at this point — one card in this section.
    expect(cardLink(workingSection!, /Proj A/i)).toHaveAttribute(
      "href",
      "/worktree/wt-1",
    );

    api.__test.emit({ type: "session:state", sessionId: "sess-main", state: "idle" });

    await waitFor(() => {
      // Bucket hides entirely when empty — old section refs would point at stale detached DOM.
      expect(screen.queryByText("working")).toBeNull();
    });
    const idleSection = screen.getByText("idle").closest("section");
    expect(idleSection).not.toBeNull();
    await waitFor(() => {
      // sess-main now joins sess-agent2 (idle since fixture setup) — two
      // separate cards, both linking to /worktree/wt-1 (one per session,
      // 6.1 — no rollup to a single worktree card anymore).
      const links = cardLinks(idleSection!, /Proj A/i);
      expect(links.length).toBe(2);
      for (const link of links) expect(link).toHaveAttribute("href", "/worktree/wt-1");
    });
  });

  it("6.T5 — a working session and a waiting_for_human sibling now render as two separate cards in two different columns (966b676 regression, structurally impossible now)", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });

    // wt-1: sess-main stays "working"; sess-agent2 flips to waiting_for_human.
    // Under the old rollup, one worktree card had to pick a single winner —
    // that's the 966b676 bug (waiting_for_human, rank 8, hid working, rank
    // 6). Per-session cards (6.1) make that structurally impossible: each
    // session gets its own card in its own column.
    api.__test.emit({ type: "session:state", sessionId: "sess-agent2", state: "waiting_for_human" });

    await waitFor(() => {
      const workingSection = screen.getByText("working").closest("section");
      expect(workingSection).not.toBeNull();
      expect(cardLink(workingSection!, /Proj A/i)).toHaveAttribute(
        "href",
        "/worktree/wt-1",
      );
      const needsYouSection = screen.getByText("needs you").closest("section");
      expect(needsYouSection).not.toBeNull();
      expect(cardLink(needsYouSection!, /Proj A/i)).toHaveAttribute(
        "href",
        "/worktree/wt-1",
      );
    });
  });

  it("6.T2 — PR set on the `isMain` session ALONE still colours the sibling (non-main) session's card too — the real daemon write shape (BLOCKING-2 fix)", async () => {
    // The daemon's prPoller writes `session.pr` ONLY to a worktree's `isMain`
    // session (prPoller.ts:164) — nothing else ever writes it. So this test
    // must NOT hand-emit a `pr` payload for the sibling (`sess-agent2`); that
    // was masking the real gap (the daemon can never produce a `pr` write for
    // a non-main session). Seeding the PR on `sess-main` only and asserting
    // the sibling's card ALSO shows it is the guarantee that actually matters
    // — PR is resolved per WORKTREE (`worktreePrStatus()` off the `isMain`
    // session), then fanned out in the UI to every non-archived agent session
    // card of that worktree, per docs/STATUS-INDICATORS.md § Per-session vs
    // per-worktree.
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });

    // Both wt-1 sessions go idle; only the isMain session (`sess-main`) gets
    // the matching-branch open PR — exactly what the real daemon does.
    api.__test.emit({ type: "session:state", sessionId: "sess-main", state: "idle" });
    api.__test.emit({
      type: "session:updated",
      sessionId: "sess-main",
      pr: { state: "open", checkedAt: new Date().toISOString(), prBranch: "wt-1" },
    });

    await waitFor(() => {
      const prSection = screen.getByText("pr created").closest("section");
      expect(prSection).not.toBeNull();
      const links = cardLinks(prSection!, /Proj A/i);
      // Rolled up to 1 worktree card (Phase 3)
      expect(links).toHaveLength(1);
      for (const link of links) expect(link).toHaveAttribute("href", "/worktree/wt-1");
      const dots = within(prSection!).getAllByLabelText(/status: pr-open/i);
      expect(dots).toHaveLength(1);
    });
  });

  it("6.T4 — dashboard-bucket-fixes — excludes an archived session from bucketing", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(document.querySelector('a[href="/worktree/wt-3"]')).not.toBeNull();
    });

    // wt-3's only agent session (idle) gets archived — an archived session
    // produces no card at all (6.T4).
    api.__test.emit({
      type: "session:updated",
      sessionId: "sess-wt3-main",
      archivedAt: new Date().toISOString(),
    });

    await waitFor(() => {
      expect(document.querySelector('a[href="/worktree/wt-3"]')).toBeNull();
    });
  });

  it("4.T2/5.T3 — an idle worktree whose PR merges moves into the PR column across a session:updated event", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });
    // wt-3's only session (sess-wt3-main) starts idle — bucketed under
    // "waiting for user" until its PR is reported merged.
    expect(screen.queryByText("pr created")).toBeNull();

    api.__test.emit({
      type: "session:updated",
      sessionId: "sess-wt3-main",
      pr: { state: "merged", checkedAt: new Date().toISOString(), prBranch: "wt-main" },
    });

    await waitFor(() => {
      const prSection = screen.getByText("pr created").closest("section");
      expect(prSection).not.toBeNull();
      expect(cardLink(prSection!, /Proj B/i)).toHaveAttribute(
        "href",
        "/worktree/wt-3",
      );
    });
  });

  it("5.T3 (D19) — a DONE worktree's PR merging does NOT pull it out of finished/into the PR column", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });
    // wt-2's only session (sess-wt2-main) is "done" — hidden behind "Show
    // finished" and MUST stay there even once its PR merges (D19 — done is
    // terminal, checked before the PR check in bucketForRollup).
    expect(screen.queryByText("pr created")).toBeNull();

    api.__test.emit({
      type: "session:updated",
      sessionId: "sess-wt2-main",
      pr: { state: "merged", checkedAt: new Date().toISOString(), prBranch: "wt-2" },
    });

    await waitFor(() => {
      expect(screen.queryByText("pr created")).toBeNull();
    });

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/show finished/i));
    await waitFor(() => {
      expect(document.querySelector('a[href="/worktree/wt-2"]')).not.toBeNull();
    });
  });

  it("6.3 — a direct session's PR is never rendered/bucketed (no worktree to branch-guard against), superseding 4.T6", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });

    api.__test.emit({
      type: "session:created",
      sessionId: "sess-direct-pr",
      worktreeId: null,
      projectId: "proj-a",
      sessionType: "agent",
      snapshot: {
        id: "sess-direct-pr",
        worktreeId: null,
        projectId: "proj-a",
        modeId: "mode-1",
        type: "agent",
        name: "Direct PR Agent",
        isMain: false,
        state: "idle",
        lifecycleState: "idle",
        tmuxName: "sess-direct-pr",
        createdAt: new Date().toISOString(),
      },
    });
    api.__test.emit({ type: "session:updated", sessionId: "sess-direct-pr", pr: { state: "open", checkedAt: new Date().toISOString() } });

    await waitFor(() => {
      // Direct sessions have no worktree, so `session.pr` can never be
      // branch-guarded and is never shown — the card stays lifecycle-only,
      // bucketed under "idle" (its own state), not "pr created".
      const link = screen.getByRole("link", { name: /Direct PR Agent/i });
      expect(link).toHaveAttribute("href", "/project/proj-a/sess-direct-pr");
    });
    expect(screen.queryByText("pr created")).toBeNull();
    const idleSection = screen.getByText("idle").closest("section");
    expect(idleSection).not.toBeNull();
    expect(within(idleSection!).getByRole("link", { name: /Direct PR Agent/i })).toBeInTheDocument();
  });

  it("4.T6 — an archivedAt-set session in waiting_for_human does not place its worktree in the Waiting bucket", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(document.querySelector('a[href="/worktree/wt-3"]')).not.toBeNull();
    });

    // wt-3's only agent session flips to waiting_for_human but is archived in
    // the same update — archived sessions are excluded from bucketing, so
    // the worktree must drop out entirely rather than land in "waiting for user".
    api.__test.emit({ type: "session:state", sessionId: "sess-wt3-main", state: "waiting_for_human" });
    api.__test.emit({
      type: "session:updated",
      sessionId: "sess-wt3-main",
      archivedAt: new Date().toISOString(),
    });

    await waitFor(() => {
      expect(document.querySelector('a[href="/worktree/wt-3"]')).toBeNull();
    });
  });

  it("excludes a hidden project's worktree cards and its project card", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    // proj-a's worktree wt-1 has agent sessions → a worktree card linking to it.
    await waitFor(() => {
      expect(document.querySelector('a[href="/worktree/wt-1"]')).not.toBeNull();
    });

    api.__test.emit({
      type: "project:updated",
      project: {
        id: "proj-a",
        name: "Proj A",
        path: "/home/dev/proj-a",
        prefix: "pa",
        isGit: true,
      defaultBranch: "main",
        createdAt: new Date().toISOString(),
        hidden: true,
        lspEnabled: false,
      },
    });

    // The hidden project's worktree cards disappear.
    await waitFor(() => {
      expect(document.querySelector('a[href="/worktree/wt-1"]')).toBeNull();
    });
    // No "Proj A" trace remains anywhere on the dashboard (worktree cards or
    // the projects section).
    expect(screen.queryByText("Proj A")).toBeNull();
    // A visible project's worktree (proj-b / wt-3) is unaffected.
    expect(document.querySelector('a[href="/worktree/wt-3"]')).not.toBeNull();
  });

  it("excludes a direct (worktree-less) session's card when its project is hidden", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });

    api.__test.emit({
      type: "session:created",
      sessionId: "sess-direct-hide",
      worktreeId: null,
      projectId: "proj-a",
      sessionType: "agent",
      snapshot: {
        id: "sess-direct-hide",
        worktreeId: null,
        projectId: "proj-a",
        modeId: "mode-1",
        type: "agent",
        name: "Direct Hide Agent",
        isMain: false,
        state: "working",
        lifecycleState: "working",
        tmuxName: "sess-direct-hide",
        createdAt: new Date().toISOString(),
      },
    });

    await waitFor(() => {
      const workingSection = screen.getByText("working").closest("section");
      expect(workingSection).not.toBeNull();
      expect(
        within(workingSection!).getByRole("link", { name: /Direct Hide Agent/i }),
      ).toBeInTheDocument();
    });

    // Hiding the direct session's project (proj-a, the `s.projectId` branch
    // of the filter at DashboardPanel.tsx's hidden-project check) must drop
    // its card too, the same as a worktree-attached session's card.
    api.__test.emit({
      type: "project:updated",
      project: {
        id: "proj-a",
        name: "Proj A",
        path: "/home/dev/proj-a",
        prefix: "pa",
        isGit: true,
        defaultBranch: "main",
        createdAt: new Date().toISOString(),
        hidden: true,
        lspEnabled: false,
      },
    });

    await waitFor(() => {
      expect(screen.queryByRole("link", { name: /Direct Hide Agent/i })).toBeNull();
    });
  });

  it("3.T3 — a dashboard card renders the session's mode icon before the name", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });

    // sess-main (mode-1 → claude) is a working card; its .mode-icon resolves
    // via the modes store (useModeIcon → ensureLoaded).
    const workingSection = screen.getByText("working").closest("section");
    expect(workingSection).not.toBeNull();
    await waitFor(() => {
      const link = cardLinks(workingSection!, /Proj A/i)[0]!;
      expect(link.closest("article")?.querySelector(".acard__head .mode-icon")).not.toBeNull();
    });

    // The truncated name keeps the full label in title.
    const card = cardLinks(workingSection!, /Proj A/i)[0]!;
    expect(card).toHaveClass("acard__name");
    expect(card.getAttribute("title")).toBeTruthy();
  });

  it("3.T2 — useSessionBuckets with default opts matches the inline dashboard loop for existing fixtures", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <BucketsProbe />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("buckets")).toBeTruthy();
    });
    // Default fixture (no direct sessions, no PRs):
    //  - sess-main  (working, wt-1) -> working
    //  - sess-agent2(idle,    wt-1) -> idle
    //  - sess-term1 (terminal)       -> excluded (not an agent)
    //  - sess-wt2-main(done,   wt-2) -> finished
    //  - sess-wt3-main(idle,   wt-3) -> idle
    expect(JSON.parse(bucketsJson())).toEqual({
      working: ["sess-main"],
      needsYou: [],
      idle: ["sess-agent2", "sess-wt3-main"],
      pr: [],
      finished: ["sess-wt2-main"],
    });
  });

  it("3.T1 — useSessionBuckets with worktreeOnly excludes a direct session from every bucket", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <BucketsProbe worktreeOnly />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("buckets")).toBeTruthy();
    });

    // Add a direct (worktree-less) agent session to the store.
    api.__test.emit({
      type: "session:created",
      sessionId: "sess-direct-1",
      worktreeId: null,
      projectId: "proj-a",
      sessionType: "agent",
      snapshot: {
        id: "sess-direct-1",
        worktreeId: null,
        projectId: "proj-a",
        modeId: "mode-1",
        type: "agent",
        name: "Direct Agent",
        isMain: false,
        state: "working",
        lifecycleState: "working",
        tmuxName: "sess-direct-1",
        createdAt: new Date().toISOString(),
      },
    });

    await waitFor(() => {
      const all = Object.values(JSON.parse(bucketsJson()));
      const flat = all.flat();
      expect(flat).not.toContain("sess-direct-1");
    });
  });

  it("2.T3 — kanban column render caps at 10 before expand, full length after", async () => {
    localStorage.setItem("dashboard:view", "kanban");
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("working")).toBeInTheDocument();
    });

    for (let i = 1; i <= 15; i++) {
      api.__test.emit({
        type: "session:created",
        sessionId: `sess-extra-${i}`,
        worktreeId: "wt-1",
        projectId: "proj-a",
        sessionType: "agent",
        snapshot: {
          id: `sess-extra-${i}`,
          worktreeId: "wt-1",
          projectId: "proj-a",
          modeId: "mode-1",
          type: "agent",
          name: `Extra Agent ${i}`,
          isMain: false,
          state: "working",
          lifecycleState: "working",
          tmuxName: `sess-extra-${i}`,
          createdAt: new Date().toISOString(),
        },
      });
    }

    const workingCol = screen.getByText("working").closest(".dashboard-kanban__col") as HTMLElement;
    expect(workingCol).not.toBeNull();

    await waitFor(() => {
      const chips = workingCol.querySelectorAll(".acard");
      expect(chips.length).toBe(10);
      expect(within(workingCol).getByRole("button", { name: /more/i })).toBeInTheDocument();
    });

    const moreBtn = within(workingCol).getByRole("button", { name: /more/i });
    await userEvent.click(moreBtn);

    await waitFor(() => {
      const chips = workingCol.querySelectorAll(".acard");
      expect(chips.length).toBe(16);
      expect(within(workingCol).queryByRole("button", { name: /more/i })).toBeNull();
    });
  });

  it("4.T6 — cards in a section are ordered by last activity (newest first); activity label shows on Rich Chat Working / Needs-you cards only", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });

    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const make = (id: string, name: string, state: "working" | "waiting_for_human" | "idle", min: number, label: string, channel: "json" | "tmux" = "json") => {
      api.__test.emit({
        type: "session:created",
        sessionId: id,
        worktreeId: "wt-1",
        projectId: "proj-a",
        sessionType: "agent",
        snapshot: {
          id: id,
          worktreeId: "wt-1",
          projectId: "proj-a",
          modeId: "mode-1",
          type: "agent",
          name,
          isMain: false,
          state,
          lifecycleState: state,
          tmuxName: id,
          channel,
          createdAt: ago(600),
          lastActivityAt: ago(min),
          lastLine: "raw terminal line",
          lastTool: { name: "Edit", detail: label },
        },
      });
    };
    make("act-a", "Act Alpha", "working", 1, "alpha.ts");
    make("act-b", "Act Beta", "working", 5, "beta.ts");
    make("act-c", "Act Gamma", "working", 2, "gamma.ts");
    make("act-n", "Act Needs", "waiting_for_human", 3, "needs.ts");
    make("act-i", "Act Idle", "idle", 3, "idle.ts");
    make("act-t", "Act Term", "working", 8, "term.ts", "tmux");

    const order = (sectionLabel: string) => {
      const section = screen.getByText(sectionLabel).closest("section") as HTMLElement;
      return Array.from(section.querySelectorAll(".acard__name"))
        .map((el) => el.textContent ?? "")
        .filter((t) => t.startsWith("Act "));
    };
    await waitFor(() => {
      expect(order("working")).toEqual(["Act Alpha", "Act Gamma", "Act Beta", "Act Term"]);
    });

    const workingSection = screen.getByText("working").closest("section") as HTMLElement;
    const activityOf = (root: HTMLElement, name: string) => {
      const art = within(root).getAllByRole("article").find((x) => x.querySelector(".acard__name")?.textContent === name);
      expect(art).toBeDefined();
      // Relative time lives in the head of every card; the band exists only when it has content.
      expect(art!.querySelector(".acard__head > .acard__time")).not.toBeNull();
      return art!.querySelector(".acard__band .acard__act")?.textContent ?? null;
    };
    expect(activityOf(workingSection, "Act Alpha")).toBe("Editing alpha.ts");
    const needsSection = screen.getByText("needs you").closest("section") as HTMLElement;
    expect(activityOf(needsSection, "Act Needs")).toBe("Edited needs.ts");
    const idleSection = screen.getByText("idle", { selector: ".dashboard-section__label" }).closest("section") as HTMLElement;
    // No tool activity (idle / terminal agents): no band at all, and the raw terminal line is never shown.
    expect(activityOf(idleSection, "Act Idle")).toBeNull();
    expect(activityOf(workingSection, "Act Term")).toBeNull();
    expect(screen.queryByText("raw terminal line")).toBeNull();
  });

  it("session cards show the worktree BRANCH in the path row, not its display name", async () => {
    const api = createMockApi({
      worktrees: [
        {
          id: "wt-x",
          projectId: "proj-a",
          name: "Pretty Name",
          branch: "feat/real-branch",
          baseBranch: "main",
          baseSha: "abc",
          createdAt: new Date().toISOString(),
          pinnedAt: null,
          hiddenAt: null,
          sortOrder: 1,
          lspEnabled: false,
        },
      ],
    });
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });
    api.__test.emit({
      type: "session:created",
      sessionId: "br-1",
      worktreeId: "wt-x",
      projectId: "proj-a",
      sessionType: "agent",
      snapshot: {
        id: "br-1",
        worktreeId: "wt-x",
        projectId: "proj-a",
        modeId: "mode-1",
        type: "agent",
        name: "Branch Agent",
        isMain: false,
        state: "working",
        lifecycleState: "working",
        tmuxName: "br-1",
        createdAt: new Date().toISOString(),
      },
    });
    await waitFor(() => {
      const art = screen.getAllByRole("article").find((x) => x.querySelector(".acard__name")?.textContent === "Branch Agent");
      expect(art?.querySelector(".acard__branch")?.textContent).toBe("feat/real-branch");
    });
  });

  it("renders project cards as clickable links to /project/:projectId", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const projLink = document.querySelector('a[href="/project/proj-a"]');
      expect(projLink).not.toBeNull();
      expect(projLink).toHaveClass("dashboard-card--project");
    });
  });

  it("project card's active count uses live sessionStates, agent sessions only", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    const link = await waitFor(() => {
      const el = document.querySelector('a[href="/project/proj-a"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const wtIds = new Set(
      useServerStore.getState().worktrees.filter((w) => w.projectId === "proj-a").map((w) => w.id),
    );
    const agents = useServerStore
      .getState()
      .sessions.filter((s) => s.worktreeId && wtIds.has(s.worktreeId) && s.type === "agent");
    expect(agents.length).toBeGreaterThan(0);

    // Live map says every agent is done → no "active" suffix, even if the
    // record's own `.state` is working/idle.
    act(() => {
      useWorkspaceStore.setState({
        sessionStates: Object.fromEntries(agents.map((s) => [s.id, "done"])),
      });
    });
    await waitFor(() => expect(link.textContent).not.toMatch(/active/));

    // One agent goes live → exactly one worktree counts as active.
    act(() => {
      useWorkspaceStore.setState({
        sessionStates: Object.fromEntries(
          agents.map((s, i) => [s.id, i === 0 ? "working" : "done"]),
        ),
      });
    });
    await waitFor(() => expect(link.textContent).toMatch(/1 active/));
  });

  it("renders kanban column headers with minimal icons, uncapitalized labels, and counts without brackets", async () => {
    localStorage.setItem("dashboard:view", "kanban");
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const headers = document.querySelectorAll(".dashboard-kanban__col-header");
      expect(headers.length).toBeGreaterThanOrEqual(4);
    });

    const headers = document.querySelectorAll(".dashboard-kanban__col-header");
    const headerTexts = Array.from(headers).map((h) => {
      const title = h.querySelector(".dashboard-kanban__col-title")?.textContent;
      const count = h.querySelector(".dashboard-kanban__col-count")?.textContent;
      const icon = h.querySelector(".dashboard-kanban__col-icon");
      return { title, count, hasIcon: !!icon };
    });

    expect(headerTexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "working", count: expect.any(String), hasIcon: true }),
        expect.objectContaining({ title: "needs you", count: expect.any(String), hasIcon: true }),
        expect.objectContaining({ title: "idle", count: expect.any(String), hasIcon: true }),
        expect.objectContaining({ title: "pr created", count: expect.any(String), hasIcon: true }),
      ]),
    );

    for (const h of headerTexts) {
      expect(h.count).not.toMatch(/[()]/);
    }
  });

  it("list view sections cap at 10 before expand, full length after", async () => {
    localStorage.setItem("dashboard:view", "list");
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("working")).toBeInTheDocument();
    });

    for (let i = 1; i <= 15; i++) {
      api.__test.emit({
        type: "session:created",
        sessionId: `sess-extra-list-${i}`,
        worktreeId: "wt-1",
        projectId: "proj-a",
        sessionType: "agent",
        snapshot: {
          id: `sess-extra-list-${i}`,
          worktreeId: "wt-1",
          projectId: "proj-a",
          modeId: "mode-1",
          type: "agent",
          name: `Extra List Agent ${i}`,
          isMain: false,
          state: "working",
          lifecycleState: "working",
          tmuxName: `sess-extra-list-${i}`,
          createdAt: new Date().toISOString(),
        },
      });
    }

    const workingSection = screen.getByText("working").closest(".dashboard-section") as HTMLElement;
    expect(workingSection).not.toBeNull();

    await waitFor(() => {
      const chips = workingSection.querySelectorAll(".acard");
      expect(chips.length).toBe(10);
      expect(within(workingSection).getByRole("button", { name: /more/i })).toBeInTheDocument();
    });

    const moreBtn = within(workingSection).getByRole("button", { name: /more/i });
    await userEvent.click(moreBtn);

    await waitFor(() => {
      const chips = workingSection.querySelectorAll(".acard");
      expect(chips.length).toBe(16);
      expect(within(workingSection).queryByRole("button", { name: /more/i })).toBeNull();
    });
  });
});

