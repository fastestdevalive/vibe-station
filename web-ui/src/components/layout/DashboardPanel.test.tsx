import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, beforeEach } from "vitest";
import type { ReactNode } from "react";
import type { ApiInstance } from "@/api";
import { createMockApi } from "@/api/mock";
import { DashboardPanel, bucketForRollup } from "./DashboardPanel";
import { useServerStore } from "@/hooks/useServerStore";
import { useServerSync } from "@/hooks/useServerSync";

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
function Harness({ api, children }: { api: ApiInstance; children: ReactNode }) {
  useServerSync(api);
  return <>{children}</>;
}

describe("DashboardPanel", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
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

  it("6.T3 — dashboard-direct-agents — shows a direct (worktree-less) agent session, bucketed by its own state and linking to /session/:id", async () => {
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
      expect(link).toHaveAttribute("href", "/session/sess-direct-1");
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
    expect(within(workingSection!).getByRole("link", { name: /Proj A/i })).toHaveAttribute(
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
      const links = within(idleSection!).getAllByRole("link", { name: /Proj A/i });
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
      expect(within(workingSection!).getByRole("link", { name: /Proj A/i })).toHaveAttribute(
        "href",
        "/worktree/wt-1",
      );
      const needsYouSection = screen.getByText("needs you").closest("section");
      expect(needsYouSection).not.toBeNull();
      expect(within(needsYouSection!).getByRole("link", { name: /Proj A/i })).toHaveAttribute(
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
      const links = within(prSection!).getAllByRole("link", { name: /Proj A/i });
      expect(links).toHaveLength(2);
      for (const link of links) expect(link).toHaveAttribute("href", "/worktree/wt-1");
      // Both cards' dots resolve to pr-open — no isMain preference on which
      // CARD shows the branch's PR, even though only the isMain session's
      // own `.pr` field was ever written.
      const dots = within(prSection!).getAllByLabelText(/status: pr-open/i);
      expect(dots).toHaveLength(2);
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
      expect(within(prSection!).getByRole("link", { name: /Proj B/i })).toHaveAttribute(
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
      expect(link).toHaveAttribute("href", "/session/sess-direct-pr");
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
      },
    });

    await waitFor(() => {
      expect(screen.queryByRole("link", { name: /Direct Hide Agent/i })).toBeNull();
    });
  });
});
