import type { ArtifactRow, ArtifactUpsert } from "@/api/types";

export function makeRow(over: Partial<ArtifactRow> & { id: string }): ArtifactRow {
  return {
    scopeKind: "worktree",
    scopeId: "wt1",
    path: `/repo/docs/${over.id}.md`,
    displayPath: `docs/${over.id}.md`,
    inRepo: true,
    kind: "doc",
    size: 100,
    state: "ok",
    pinned: false,
    editCount: 1,
    writers: [],
    addedVia: "capture",
    createdAt: "2026-10-27T10:00:00.000Z",
    lastWrittenAt: "2026-10-27T10:00:00.000Z",
    ...over,
  };
}

export function upsert(over: Partial<ArtifactRow> & { id: string }, created = false): ArtifactUpsert {
  return { ...makeRow(over), created };
}
