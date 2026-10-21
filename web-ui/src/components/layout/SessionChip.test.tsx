import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SessionChip } from "./SessionChip";
import type { PrStatus } from "@/api/types";

const openExternal = vi.fn();
vi.mock("@/lib/openExternal", () => ({ openExternal: (u: string) => openExternal(u) }));

const openPr: PrStatus = {
  state: "open",
  number: 142,
  url: "https://github.com/acme/repo/pull/142",
  checkedAt: "2026-10-21T00:00:00Z",
};

const wtProps = {
  status: "idle" as const,
  pr: null,
  sessionLabel: "Agent Alpha",
  worktreeLabel: "feat/login",
  projectLabel: "Project Zero",
};

describe("SessionChip (agent card, option E)", () => {
  it("is an <article>: head (agent icon + name + relative time), path row; no status dot", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    const { container } = render(<SessionChip {...wtProps} activityAt={twoDaysAgo} />);

    const card = container.firstElementChild as HTMLElement;
    expect(card.tagName).toBe("ARTICLE");
    expect(card).toHaveClass("acard");
    expect(card.querySelector(".status-dot, .status-spinner")).toBeNull();
    const head = card.querySelector(".acard__head");
    expect(head?.querySelector(".acard__agent .mode-icon")).not.toBeNull();
    expect(head?.textContent).toContain("Agent Alpha");
    expect(head?.querySelector("time.acard__time")?.textContent).toBe("2d");
    // time is the last child of the head, after the name
    expect(head?.lastElementChild).toHaveClass("acard__time");
    expect(card.querySelector(".acard__band")).toBeNull();
    // no activity, no PR: the card ends after the path row
    expect(Array.from(card.children).map((c) => c.className.split(" ")[0])).toEqual([
      "acard__head",
      "acard__path",
    ]);
  });

  it("time sits in the head on every card; never in the band; keeps the full-timestamp tooltip", () => {
    const at = "2026-10-20T10:00:00Z";
    const variants = [
      <SessionChip key="a" {...wtProps} activityAt={at} />,
      <SessionChip key="b" {...wtProps} activityAt={at} channel="pty" />,
      <SessionChip key="c" {...wtProps} activityAt={at} pr={openPr} />,
      <SessionChip key="d" {...wtProps} activityAt={at} channel="json" lastTool={{ name: "Edit", detail: "a.ts" }} />,
      <SessionChip key="e" {...wtProps} activityAt={at} isDirect worktreeLabel={null} />,
    ];
    for (const v of variants) {
      const { container, unmount } = render(v);
      expect(container.querySelectorAll(".acard__head > time.acard__time").length).toBe(1);
      expect(container.querySelector(".acard__band .acard__time")).toBeNull();
      expect(container.querySelector("time.acard__time")?.getAttribute("title")).toMatch(/^Last activity /);
      unmount();
    }
  });

  it("band is absent for terminal / idle / finished cards with no PR and no activity", () => {
    for (const status of ["idle", "done", "exited", "working"] as const) {
      const { container, unmount } = render(<SessionChip {...wtProps} status={status} channel="pty" />);
      expect(container.querySelector(".acard__band")).toBeNull();
      unmount();
    }
  });

  it("band appears with activity only (no chip)", () => {
    const { container } = render(
      <SessionChip {...wtProps} status="working" channel="json" lastTool={{ name: "Edit", detail: "a.ts" }} />,
    );
    expect(container.querySelector(".acard__band .acard__act")).not.toBeNull();
    expect(container.querySelector(".acard__band .pr-chip")).toBeNull();
  });

  it("band appears with a PR chip only: empty activity slot stays so the chip sits right", () => {
    const { container } = render(<SessionChip {...wtProps} pr={openPr} />);
    const band = container.querySelector(".acard__band") as HTMLElement;
    expect(band).not.toBeNull();
    const act = band.querySelector(".acard__act") as HTMLElement;
    expect(act.childElementCount).toBe(0);
    expect(band.querySelector(".pr-chip")).not.toBeNull();
    expect(band.lastElementChild).toHaveClass("pr-chip");
  });

  it("an unrenderable PR (no number/url) does not create a band", () => {
    const { container } = render(<SessionChip {...wtProps} pr={{ state: "none" } as unknown as PrStatus} />);
    expect(container.querySelector(".acard__band")).toBeNull();
  });

  it("conveys status on the agent icon (aria-label + title), not a glyph", () => {
    render(<SessionChip {...wtProps} status="waiting_for_human" sessionLabel="Alpha" />);
    const mark = screen.getByRole("img", { name: "status: waiting for human" });
    expect(mark.getAttribute("title")).toBe("Alpha · waiting for human");
    expect(mark.textContent).not.toContain("!");
  });

  it("name link carries the folded tooltip (the stretched ::after blocks child tooltips)", () => {
    const at = "2026-10-20T10:00:00Z";
    render(
      <SessionChip
        {...wtProps}
        status="working"
        channel="json"
        lastTool={{ name: "Edit", detail: "a.ts" }}
        activityAt={at}
        href="/worktree/wt1"
      />,
    );
    const link = screen.getByRole("link", { name: "Agent Alpha" });
    const t = link.getAttribute("title") ?? "";
    expect(t).toContain("Agent Alpha · working");
    expect(t).toContain("Project Zero / feat/login");
    expect(t).toContain("Editing a.ts");
    expect(t).toContain("Last activity ");
    expect(screen.getByRole("img", { name: "status: working" })).toBeInTheDocument();
  });

  it("name link title omits activity and time when absent", () => {
    render(<SessionChip {...wtProps} href="/x" />);
    expect(screen.getByRole("link", { name: "Agent Alpha" }).getAttribute("title")).toBe(
      "Agent Alpha · idle — Project Zero / feat/login",
    );
  });

  it("worktree card: path row is project / worktree glyph + mono branch", () => {
    const { container } = render(<SessionChip {...wtProps} />);
    const path = container.querySelector(".acard__path") as HTMLElement;
    expect(path.classList.contains("acard__path--direct")).toBe(false);
    expect(path.querySelector(".acard__project")?.textContent).toBe("Project Zero");
    expect(path.querySelector(".acard__sep")?.textContent).toBe("/");
    expect(path.querySelectorAll("svg.acard__glyph circle").length).toBe(3);
    expect(path.querySelector(".acard__branch")?.textContent).toBe("feat/login");
    expect(path.querySelector(".dtag")).toBeNull();
  });

  it("direct agent: project + neutral 'direct' pill, no glyph/slash, never a PR chip", () => {
    const { container } = render(
      <SessionChip {...wtProps} isDirect pr={openPr} sessionLabel="Agent Direct" worktreeLabel={null} />,
    );
    const path = container.querySelector(".acard__path") as HTMLElement;
    expect(path).toHaveClass("acard__path--direct");
    expect(path.querySelector(".acard__project")?.textContent).toBe("Project Zero");
    expect(path.querySelector(".dtag")?.textContent).toBe("direct");
    expect(path.querySelector(".acard__glyph, .acard__sep")).toBeNull();
    expect(container.querySelector(".pr-chip")).toBeNull();
    expect(container.firstElementChild).toHaveClass("acard--direct");
    // direct agent without activity: no band even though a PR was passed
    expect(container.querySelector(".acard__band")).toBeNull();
  });

  it("direct agent with activity gets a band, still without a PR chip", () => {
    const { container } = render(
      <SessionChip {...wtProps} isDirect pr={openPr} worktreeLabel={null} channel="json" lastTool={{ name: "Read", detail: "x.ts" }} />,
    );
    expect(container.querySelector(".acard__band .acard__act")).not.toBeNull();
    expect(container.querySelector(".pr-chip")).toBeNull();
  });

  it("name is a stretched link: the card is not an anchor and nothing nests an anchor", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <SessionChip {...wtProps} pr={openPr} sessionLabel="Agent Click" href="/worktree/wt1" onClick={onClick} />,
    );
    const link = screen.getByRole("link", { name: "Agent Click" });
    expect(link).toHaveClass("acard__name");
    expect(link).toHaveAttribute("href", "/worktree/wt1");
    expect(container.querySelector("a a, a [role='link']")).toBeNull();
    expect(container.firstElementChild?.tagName).not.toBe("A");
    await userEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("modifier-click on the name falls through to the browser (no onClick)", () => {
    const onClick = vi.fn();
    render(<SessionChip {...wtProps} sessionLabel="Mod" href="/worktree/w" onClick={onClick} />);
    fireEvent.click(screen.getByRole("link", { name: "Mod" }), { metaKey: true });
    fireEvent.click(screen.getByRole("link", { name: "Mod" }), { ctrlKey: true });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("without href the name is a button that triggers onClick", async () => {
    const onClick = vi.fn();
    render(<SessionChip {...wtProps} sessionLabel="Btn" onClick={onClick} />);
    await userEvent.click(screen.getByRole("button", { name: "Btn" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("PR chip is a link-role element in the band, opens the PR and does not navigate the card", async () => {
    openExternal.mockClear();
    const onClick = vi.fn();
    const { container } = render(
      <SessionChip {...wtProps} pr={openPr} href="/worktree/wt1" onClick={onClick} />,
    );
    const band = container.querySelector(".acard__band") as HTMLElement;
    const chip = within(band).getByRole("link", { name: /pull request #142 \(open\)/i });
    expect(chip.tagName).not.toBe("A");
    expect(chip.textContent).toBe("#142");
    expect(chip.closest("a")).toBeNull();
    await userEvent.click(chip);
    expect(openExternal).toHaveBeenCalledWith(openPr.url);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("no PR chip without a PR", () => {
    const { container } = render(<SessionChip {...wtProps} />);
    expect(container.querySelector(".pr-chip")).toBeNull();
  });

  it("Rich Chat agent with a tool call: band activity = icon + sans verb + mono target", () => {
    const { container } = render(
      <SessionChip {...wtProps} status="working" channel="json" lastTool={{ name: "Edit", detail: "parseConfig.ts" }} />,
    );
    const act = container.querySelector(".acard__band .acard__act") as HTMLElement;
    expect(act.textContent).toBe("Editing parseConfig.ts");
    expect(act.getAttribute("title")).toBe("Editing parseConfig.ts");
    expect(act.querySelector("svg")).not.toBeNull();
    expect(act.querySelector("code")?.textContent).toBe("parseConfig.ts");
  });

  it("json channel renders the bare icon; terminal channels get the framed icon", () => {
    const { container, rerender } = render(<SessionChip {...wtProps} modeIconKey="claude" channel="json" />);
    expect(container.querySelector(".mode-icon")).not.toBeNull();
    expect(container.querySelector(".mode-icon--terminal")).toBeNull();
    expect(container.querySelector(".acard__agent--tty")).toBeNull();
    rerender(<SessionChip {...wtProps} modeIconKey="claude" channel="pty" />);
    expect(container.querySelector(".mode-icon--terminal")).not.toBeNull();
    expect(container.querySelector(".acard__agent--tty")).not.toBeNull();
  });

  it("does not use lucide FolderGit2 anywhere in the card code", () => {
    for (const f of ["SessionChip.tsx", "WorktreeGlyph.tsx", "DashboardPanel.tsx", "ProjectHomeTab.tsx"]) {
      const src = readFileSync(resolve(__dirname, f), "utf8");
      expect(src).not.toMatch(/FolderGit2/);
    }
  });
});

describe("AgentCard.css", () => {
  const css = readFileSync(resolve(__dirname, "AgentCard.css"), "utf8");
  const rule = (sel: string) => {
    const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`));
    return m?.[1] ?? "";
  };

  it("path row grid shares space between project and branch and never wraps", () => {
    const r = rule(".acard__path");
    expect(r).toMatch(/grid-template-columns:\s*minmax\(0,\s*max-content\)\s+max-content\s+minmax\(10%,\s*max-content\)/);
    expect(r).toMatch(/white-space:\s*nowrap/);
  });

  it("name link is stretched over the card; band is 32px with a top border; time is right-aligned in the head", () => {
    expect(rule(".acard__name::after")).toMatch(/position:\s*absolute;[\s\S]*inset:\s*0/);
    const band = rule(".acard__band");
    expect(band).toMatch(/min-height:\s*32px/);
    expect(band).toMatch(/border-top:\s*1px solid var\(--border-default\)/);
    expect(rule(".acard__band .pr-chip")).toMatch(/z-index:\s*1/);
    expect(rule(".acard__time")).toMatch(/margin-left:\s*auto/);
    expect(rule(".acard__time")).toMatch(/flex:\s*none/);
    expect(rule(".acard__name")).toMatch(/flex:\s*1 1 auto/);
    expect(rule(".acard__name")).toMatch(/min-width:\s*0/);
  });
});
