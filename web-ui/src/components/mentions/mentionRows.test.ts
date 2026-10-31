import { describe, it, expect } from "vitest";
import type { MentionKind } from "@/api/types";
import { parseMentionQuery } from "./mentionQuery";
import {
  buildMentionRows,
  selectableRows,
  type MentionItem,
  type SourceResult,
  type MentionRow,
} from "./mentionRows";

function makeSources(over: Partial<Record<MentionKind, SourceResult>> = {}): Record<MentionKind, SourceResult> {
  return {
    file: { items: [] },
    agent: { items: [] },
    worktree: { items: [] },
    project: { items: [] },
    ...over,
  };
}

describe("mentionRows (1.T11)", () => {
  it("empty raw -> groups (3 max) then 'Narrow to' + 4 scope rows", () => {
    const files: MentionItem[] = [
      { kind: "file", id: "f1", label: "f1.ts", secondary: "src" },
      { kind: "file", id: "f2", label: "f2.ts", secondary: "src" },
      { kind: "file", id: "f3", label: "f3.ts", secondary: "src" },
      { kind: "file", id: "f4", label: "f4.ts", secondary: "src" },
    ];
    const agents: MentionItem[] = [
      { kind: "agent", id: "a1", label: "Agent 1", secondary: "claude" },
      { kind: "agent", id: "a2", label: "Agent 2", secondary: "claude" },
      { kind: "agent", id: "a3", label: "Agent 3", secondary: "claude" },
      { kind: "agent", id: "a4", label: "Agent 4", secondary: "claude" },
    ];

    const sources = makeSources({
      file: { items: files },
      agent: { items: agents },
    });

    const rows = buildMentionRows(parseMentionQuery(""), sources, { limitReached: false });

    // File group: 1 header + 3 items
    expect(rows[0]).toEqual({ type: "header", title: "Files", caption: "this worktree" });
    const fileItems = rows.slice(1, 4);
    expect(fileItems.every((r) => r.type === "item" && r.item.kind === "file")).toBe(true);

    // Agent group: 1 header + 3 items
    expect(rows[4]).toEqual({ type: "header", title: "Agents", caption: "this project" });
    const agentItems = rows.slice(5, 8);
    expect(agentItems.every((r) => r.type === "item" && r.item.kind === "agent")).toBe(true);

    // Narrow to header
    expect(rows[8]).toEqual({ type: "header", title: "Narrow to" });

    // 4 scope rows
    const scopeRows = rows.slice(9);
    expect(scopeRows).toEqual([
      { type: "scope", kind: "file", label: "@files:" },
      { type: "scope", kind: "agent", label: "@agents:" },
      { type: "scope", kind: "worktree", label: "@worktrees:" },
      { type: "scope", kind: "project", label: "@projects:" },
    ]);
  });

  it("'ag' -> SCOPE header, agents scope row, agents group first", () => {
    const files: MentionItem[] = [
      { kind: "file", id: "f1", label: "agent_notes.txt", secondary: "docs" },
    ];
    const agents: MentionItem[] = [
      { kind: "agent", id: "a1", label: "Agent 1", secondary: "claude" },
      { kind: "agent", id: "a2", label: "Agent 2", secondary: "claude" },
    ];

    const sources = makeSources({
      file: { items: files },
      agent: { items: agents },
    });

    const rows = buildMentionRows(parseMentionQuery("ag"), sources, { limitReached: false });

    // SCOPE header + agents scope row
    expect(rows[0]).toEqual({ type: "header", title: "SCOPE", caption: "Enter to search only here" });
    expect(rows[1]).toEqual({ type: "scope", kind: "agent", label: "@agents:" });

    // Agents group listed FIRST
    expect(rows[2]).toEqual({ type: "header", title: "Agents", caption: "this project" });
    expect(rows[3]).toEqual({ type: "item", item: agents[0] });
    expect(rows[4]).toEqual({ type: "item", item: agents[1] });

    // Files group listed after
    expect(rows[5]).toEqual({ type: "header", title: "Files", caption: "this worktree" });
    expect(rows[6]).toEqual({ type: "item", item: files[0] });
  });

  it("scoped agents -> no headers, 10 max", () => {
    const agents: MentionItem[] = Array.from({ length: 15 }, (_, i) => ({
      kind: "agent",
      id: `a${i}`,
      label: `Agent ${i}`,
      secondary: "claude",
    }));

    const sources = makeSources({ agent: { items: agents } });
    const rows = buildMentionRows(parseMentionQuery("agents:"), sources, { limitReached: false });

    // No header rows
    expect(rows.some((r) => r.type === "header")).toBe(false);
    // 10 max items
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.type === "item")).toBe(true);
  });

  it("every status row text from Decision 9", () => {
    // 1. Searching files…
    const loadingRows = buildMentionRows(
      parseMentionQuery("files:"),
      makeSources({ file: { items: [], loading: true } }),
      { limitReached: false },
    );
    expect(loadingRows).toEqual([{ type: "status", text: "Searching files…" }]);

    // 2. File search failed
    const errorRows = buildMentionRows(
      parseMentionQuery("files:"),
      makeSources({ file: { items: [], error: "File search failed" } }),
      { limitReached: false },
    );
    expect(errorRows).toEqual([{ type: "status", text: "File search failed" }]);

    // 3. No <section> match "<q>"
    const emptyScoped = buildMentionRows(
      parseMentionQuery("agents:foobar"),
      makeSources({ agent: { items: [] } }),
      { limitReached: false },
    );
    expect(emptyScoped).toEqual([{ type: "status", text: 'No agents match "foobar"' }]);

    // 4. all-empty unscoped "No matches"
    const emptyUnscoped = buildMentionRows(
      parseMentionQuery("zzz"),
      makeSources(),
      { limitReached: false },
    );
    expect(emptyUnscoped).toEqual([{ type: "status", text: "No matches" }]);

    // 5. Choose a project to search files
    const noTargetRows = buildMentionRows(
      parseMentionQuery("files:"),
      makeSources({ file: { items: [], unavailable: "Choose a project to search files" } }),
      { limitReached: false },
    );
    expect(noTargetRows).toEqual([{ type: "status", text: "Choose a project to search files" }]);

    // 6. Mention limit (50) reached
    const limitRows = buildMentionRows(
      parseMentionQuery(""),
      makeSources(),
      { limitReached: true },
    );
    expect(limitRows).toEqual([{ type: "status", text: "Mention limit (50) reached" }]);
  });

  it("limitReached -> only the limit row and zero selectable", () => {
    const sources = makeSources({
      agent: { items: [{ kind: "agent", id: "a1", label: "Agent", secondary: "" }] },
    });
    const rows = buildMentionRows(parseMentionQuery(""), sources, { limitReached: true });
    expect(rows).toEqual([{ type: "status", text: "Mention limit (50) reached" }]);
    expect(selectableRows(rows)).toEqual([]);
  });

  it("selectableRows skips headers and status rows", () => {
    const testRows: MentionRow[] = [
      { type: "header", title: "SCOPE" },
      { type: "scope", kind: "agent", label: "@agents:" },
      { type: "header", title: "Agents" },
      { type: "item", item: { kind: "agent", id: "a1", label: "Agent 1", secondary: "" } },
      { type: "status", text: "Searching files…" },
    ];

    const selectable = selectableRows(testRows);
    expect(selectable).toEqual([
      { type: "scope", kind: "agent", label: "@agents:" },
      { type: "item", item: { kind: "agent", id: "a1", label: "Agent 1", secondary: "" } },
    ]);
  });

  it("Files group caption is 'this project' in project file scope", () => {
    const sources = makeSources({
      file: { items: [{ kind: "file", id: "f1", label: "f1.ts", secondary: "src" }] },
    });
    const proj = buildMentionRows(parseMentionQuery(""), sources, { limitReached: false, fileScope: "project" });
    expect(proj[0]).toEqual({ type: "header", title: "Files", caption: "this project" });
    const wt = buildMentionRows(parseMentionQuery(""), sources, { limitReached: false, fileScope: "worktree" });
    expect(wt[0]).toEqual({ type: "header", title: "Files", caption: "this worktree" });
  });

  it("keeps server order for file items: fuzzy-only and path-spanning matches are not dropped", () => {
    const files: MentionItem[] = [
      { kind: "file", id: "src/components/QuickOpen.tsx", label: "QuickOpen.tsx", secondary: "src/components" },
      { kind: "file", id: "docs/zzz.md", label: "zzz.md", secondary: "docs" },
      { kind: "file", id: "a/auth/middleware.ts", label: "middleware.ts", secondary: "a/auth" },
    ];
    const sources = makeSources({ file: { items: files } });

    // fuzzy-only: "qkopn" is not a substring of anything
    const fuzzy = buildMentionRows(parseMentionQuery("files:qkopn"), sources, { limitReached: false });
    expect(fuzzy.filter((r) => r.type === "item").map((r) => (r as { item: MentionItem }).item.id)).toEqual(
      files.map((f) => f.id),
    );

    // path-spanning / multi-word
    for (const q of ["files:auth middleware", "files:src/components/Quick"]) {
      const rows = buildMentionRows(parseMentionQuery(q), sources, { limitReached: false });
      expect(rows.filter((r) => r.type === "item")).toHaveLength(3);
    }

    // unscoped keeps order and caps at 3 per group
    const many = Array.from({ length: 5 }, (_, i) => ({
      kind: "file" as const, id: `f${i}.ts`, label: `f${i}.ts`, secondary: "",
    }));
    const unscoped = buildMentionRows(parseMentionQuery("qq"), makeSources({ file: { items: many } }), {
      limitReached: false,
    });
    expect(unscoped.filter((r) => r.type === "item").map((r) => (r as { item: MentionItem }).item.id)).toEqual([
      "f0.ts", "f1.ts", "f2.ts",
    ]);
  });

  describe("slow indexing status", () => {
    const slow = makeSources({ file: { items: [], indexing: true, slowIndexing: true } });
    const text = "Indexing files… (taking longer than usual)";

    it("shows the slow Indexing row in every query shape, never 'No matches'", () => {
      for (const q of ["foo", "", "files:foo"]) {
        const rows = buildMentionRows(parseMentionQuery(q), slow, { limitReached: false });
        expect(rows).toContainEqual({ type: "status", text });
        expect(rows).not.toContainEqual({ type: "status", text: "No matches" });
      }
    });
  });

  describe("indexing status", () => {
    const idx = makeSources({ file: { items: [], indexing: true } });

    it("unscoped query shows an Indexing row in the Files group, not 'No matches'", () => {
      const rows = buildMentionRows(parseMentionQuery("foo"), idx, { limitReached: false });
      expect(rows).toContainEqual({ type: "status", text: "Indexing files…" });
      expect(rows).not.toContainEqual({ type: "status", text: "No matches" });
    });

    it("empty @ shows the Indexing row under Files", () => {
      const rows = buildMentionRows(parseMentionQuery(""), idx, { limitReached: false });
      expect(rows).toContainEqual({ type: "status", text: "Indexing files…" });
    });

    it("@files: scope shows the Indexing row instead of 'No files match'", () => {
      const rows = buildMentionRows(parseMentionQuery("files:foo"), idx, { limitReached: false });
      expect(rows).toEqual([{ type: "status", text: "Indexing files…" }]);
    });
  });
});

describe("worktree scope rows (cross-project)", () => {
  const wts: MentionItem[] = [
    { kind: "worktree", id: "w1", label: "fix-login", secondary: "fix/login" },
    { kind: "worktree", id: "w2", label: "billing", secondary: "feat/billing" },
  ];
  const projects: MentionItem[] = [
    { kind: "project", id: "p-cur", label: "current", secondary: "~/cur" },
    { kind: "project", id: "p-other", label: "other-proj", secondary: "~/other" },
  ];

  it("lists current-project worktrees first, then other projects as scope rows that rewrite the token", () => {
    const rows = buildMentionRows(
      parseMentionQuery("worktrees:", [{ id: "p-other", name: "other-proj" }]),
      makeSources({ worktree: { items: wts }, project: { items: projects } }),
      { limitReached: false, currentProjectId: "p-cur" },
    );
    expect(rows.slice(0, 2).map((r) => r.type)).toEqual(["item", "item"]);
    const scopes = rows.filter((r): r is Extract<MentionRow, { type: "scope" }> => r.type === "scope");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.insertRaw).toBe("worktrees:other-proj:");
  });

  it("filters the picker by the typed project name and keeps matching current worktrees", () => {
    const rows = buildMentionRows(
      parseMentionQuery("worktrees:oth", []),
      makeSources({ worktree: { items: wts }, project: { items: projects } }),
      { limitReached: false, currentProjectId: "p-cur" },
    );
    expect(rows.filter((r) => r.type === "item")).toHaveLength(0);
    expect(rows.filter((r) => r.type === "scope")).toHaveLength(1);
  });

  it("with a picked project, ranks only the worktree half and shows no picker", () => {
    const parsed = parseMentionQuery("worktrees:other-proj:bill", [{ id: "p-other", name: "other-proj" }]);
    const rows = buildMentionRows(parsed, makeSources({ worktree: { items: wts }, project: { items: projects } }), {
      limitReached: false,
      currentProjectId: "p-cur",
    });
    expect(rows).toEqual([{ type: "item", item: wts[1] }]);
  });

  it("empty picked project shows a named status row", () => {
    const parsed = parseMentionQuery("worktrees:other-proj:", [{ id: "p-other", name: "other-proj" }]);
    const rows = buildMentionRows(parsed, makeSources({ worktree: { items: [] } }), { limitReached: false });
    expect(rows).toEqual([{ type: "status", text: "No worktrees in other-proj" }]);
  });
});

describe("agent scope rows (cross-project)", () => {
  const agents: MentionItem[] = [
    { kind: "agent", id: "a1", label: "main", secondary: "claude · this worktree" },
    { kind: "agent", id: "a2", label: "reviewer", secondary: "claude · feat/x" },
  ];
  const projects: MentionItem[] = [
    { kind: "project", id: "p-cur", label: "current", secondary: "~/cur" },
    { kind: "project", id: "p-other", label: "other-proj", secondary: "~/other" },
  ];

  it("lists current-project agents, then project rows that rewrite the token to @agents:<project>:", () => {
    const rows = buildMentionRows(
      parseMentionQuery("agents:", []),
      makeSources({ agent: { items: agents }, project: { items: projects } }),
      { limitReached: false, currentProjectId: "p-cur" },
    );
    expect(rows.filter((r) => r.type === "item")).toHaveLength(2);
    const scopes = rows.filter((r): r is Extract<MentionRow, { type: "scope" }> => r.type === "scope");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({ kind: "agent", insertRaw: "agents:other-proj:", label: "@agents:other-proj:" });
  });

  it("picked project: ranks the filter half (name or worktree label) and shows no picker", () => {
    const parsed = parseMentionQuery("agents:other-proj:feat", [{ id: "p-other", name: "other-proj" }]);
    const rows = buildMentionRows(parsed, makeSources({ agent: { items: agents }, project: { items: projects } }), {
      limitReached: false,
      currentProjectId: "p-cur",
    });
    expect(rows).toEqual([{ type: "item", item: agents[1] }]);
  });

  it("picked project with nothing matching shows a named status", () => {
    const parsed = parseMentionQuery("agents:other-proj:zzz", [{ id: "p-other", name: "other-proj" }]);
    const rows = buildMentionRows(parsed, makeSources({ agent: { items: agents } }), { limitReached: false });
    expect(rows).toEqual([{ type: "status", text: 'No agents in other-proj match "zzz"' }]);
  });
});

describe("project picker rows — dedupe and cap", () => {
  it("one row per distinct project name, none whose token would exceed the query cap", () => {
    const rows = buildMentionRows(
      parseMentionQuery("agents:", []),
      makeSources({
        project: {
          items: [
            { kind: "project", id: "p1", label: "same", secondary: "~/a" },
            { kind: "project", id: "p2", label: "Same", secondary: "~/b" },
            { kind: "project", id: "p3", label: "x".repeat(90), secondary: "~/c" },
            { kind: "project", id: "p4", label: "ok", secondary: "~/d" },
          ],
        },
      }),
      { limitReached: false, currentProjectId: null },
    );
    const labels = rows.filter((r) => r.type === "scope").map((r) => (r as { label: string }).label);
    expect(labels).toEqual(["@agents:same:", "@agents:ok:"]);
  });
});
