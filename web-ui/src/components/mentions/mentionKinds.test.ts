import { describe, expect, it } from "vitest";
import { buildMentionRows, type SourceResult } from "./mentionRows";
import { parseMentionQuery } from "./mentionQuery";
import type { MentionKind } from "@/api/types";

const item = (kind: MentionKind, id: string) => ({ kind, id, label: id, secondary: "" });
const sources = {
  file: { items: [item("file", "src/a.ts")] },
  agent: { items: [item("agent", "agent-1")] },
  worktree: { items: [item("worktree", "wt")] },
  project: { items: [item("project", "p")] },
} as Record<MentionKind, SourceResult>;

describe("MentionEditorConfig.kinds filter (files-only comment box)", () => {
  const opts = { limitReached: false, kinds: ["file"] as MentionKind[] };

  it("bare @ lists only the Files group and no 'Narrow to' scopes", () => {
    const rows = buildMentionRows(parseMentionQuery(""), sources, opts);
    expect(rows.filter((r) => r.type === "header").map((r) => (r as { title: string }).title)).toEqual(["Files"]);
    expect(rows.some((r) => r.type === "scope")).toBe(false);
    expect(rows.filter((r) => r.type === "item")).toHaveLength(1);
  });

  it("a text query never offers other kinds", () => {
    const rows = buildMentionRows(parseMentionQuery("a"), sources, opts);
    expect(rows.every((r) => r.type !== "item" || r.item.kind === "file")).toBe(true);
    expect(rows.some((r) => r.type === "scope")).toBe(false);
  });

  it("a scoped query for a disallowed kind has nothing", () => {
    expect(buildMentionRows(parseMentionQuery("agents:x"), sources, opts)).toEqual([{ type: "status", text: "No matches" }]);
  });

  it("without kinds every group is still offered (composer unchanged)", () => {
    const rows = buildMentionRows(parseMentionQuery(""), sources, { limitReached: false });
    expect(rows.filter((r) => r.type === "scope")).toHaveLength(4);
  });
});
