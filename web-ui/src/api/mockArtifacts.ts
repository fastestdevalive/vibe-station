import { ArtifactReadError } from "./errors";
import type { ArtifactContent, ArtifactScopeParam } from "./artifactsClient";
import type { ArtifactListResponse, ArtifactRow, WSEvent } from "./types";

const CAP = 500;
const DAY = 86_400_000;

/** 1x1 transparent PNG, enough for the image preview branch of the mock. */
const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** One fixture per row state the UI renders: pinned, outside repo, image, missing, many edits, old/deleted writer. */
function fixtures(scopeKind: ArtifactScopeParam, scopeId: string, writers: string[]): ArtifactRow[] {
  const [a = "deleted-session", b = a] = writers;
  const base = { scopeKind, scopeId, size: 2048, state: "ok" as const, pinned: false, editCount: 1, addedVia: "capture" as const };
  const row = (n: string, r: Partial<ArtifactRow> & Pick<ArtifactRow, "path" | "displayPath" | "inRepo" | "kind" | "writers" | "lastWrittenAt">): ArtifactRow => ({
    ...base,
    id: `mock-art-${scopeId}-${n}`,
    createdAt: r.lastWrittenAt,
    ...r,
  });
  return [
    row("prd", { path: "/repo/docs/prd-artifacts.md", displayPath: "docs/prd-artifacts.md", inRepo: true, kind: "doc", writers: [a], pinned: true, editCount: 6, lastWrittenAt: ago(2 * 60_000) }),
    row("plan", { path: "/home/u/.claude/plans/streamed-sorting.md", displayPath: "~/.claude/plans/streamed-sorting.md", inRepo: false, kind: "doc", writers: [a], lastWrittenAt: ago(18 * 60_000) }),
    row("shot", { path: "/tmp/shots/login-screen.png", displayPath: "/tmp/shots/login-screen.png", inRepo: false, kind: "image", writers: [b], addedVia: "cli", lastWrittenAt: ago(41 * 60_000) }),
    row("note", { path: "/repo/docs/note.html", displayPath: "docs/note.html", inRepo: true, kind: "doc", writers: [a, b], editCount: 3, lastWrittenAt: ago(3 * 3_600_000) }),
    row("old", { path: "/repo/docs/old-plan.md", displayPath: "docs/old-plan.md", inRepo: true, kind: "doc", writers: [a], state: "missing", lastWrittenAt: ago(2 * DAY) }),
    row("gone", { path: "/repo/docs/legacy.md", displayPath: "docs/legacy.md", inRepo: true, kind: "doc", writers: ["deleted-agent-id"], lastWrittenAt: ago(5 * DAY) }),
  ];
}

/**
 * In-memory artifact API for mock mode and the dev state simulator. Rows are seeded per scope on first
 * list; `pin`/`remove` mutate them and push `artifact:upserted`/`removed` like the daemon does.
 */
export function createMockArtifacts(emit: (ev: WSEvent) => void, writersFor: (scopeId: string) => string[] = () => []) {
  const scopes = new Map<string, { rev: number; rows: ArtifactRow[]; hidden: Set<string> }>();
  const find = (id: string) => {
    for (const [key, s] of scopes) {
      const row = s.rows.find((r) => r.id === id);
      if (row) return { key, s, row };
    }
    return null;
  };
  const scopeOf = (scopeKind: ArtifactScopeParam, scopeId: string) => {
    const key = `${scopeKind}:${scopeId}`;
    let s = scopes.get(key);
    if (!s) {
      s = { rev: 0, rows: fixtures(scopeKind, scopeId, writersFor(scopeId)), hidden: new Set() };
      scopes.set(key, s);
    }
    return s;
  };

  return {
    async listArtifacts(scopeId: string, scope: ArtifactScopeParam = "worktree"): Promise<ArtifactListResponse> {
      const s = scopeOf(scope, scopeId);
      const items = s.rows.filter((r) => !s.hidden.has(r.id)).sort((x, y) => y.lastWrittenAt.localeCompare(x.lastWrittenAt));
      return structuredClone({ rev: s.rev, cap: CAP, total: s.rows.length, items });
    },

    async pinArtifact(id: string, pinned: boolean): Promise<ArtifactRow> {
      const hit = find(id);
      if (!hit || hit.s.hidden.has(id)) throw new ArtifactReadError("Artifact not found", 404, "ARTIFACT_NOT_FOUND");
      if (pinned && hit.s.rows.filter((r) => r.pinned).length >= 50) {
        throw new ArtifactReadError("50 pinned is the limit", 409, "PIN_LIMIT");
      }
      hit.row.pinned = pinned;
      hit.s.rev += 1;
      emit({ type: "artifact:upserted", scopeKind: hit.row.scopeKind, scopeId: hit.row.scopeId, rev: hit.s.rev, rows: [{ ...structuredClone(hit.row), created: false }] });
      return structuredClone(hit.row);
    },

    async removeArtifact(id: string): Promise<{ ok: true }> {
      const hit = find(id);
      if (!hit || hit.s.hidden.has(id)) throw new ArtifactReadError("Artifact not found", 404, "ARTIFACT_NOT_FOUND");
      hit.s.hidden.add(id);
      hit.row.pinned = false;
      hit.s.rev += 1;
      emit({ type: "artifact:removed", scopeKind: hit.row.scopeKind, scopeId: hit.row.scopeId, rev: hit.s.rev, ids: [id], reason: "removed" });
      return { ok: true };
    },

    async getArtifactContent(id: string): Promise<ArtifactContent> {
      const hit = find(id);
      if (!hit || hit.s.hidden.has(id)) throw new ArtifactReadError("No longer an artifact", 404, "ARTIFACT_NOT_FOUND");
      const { row } = hit;
      if (row.state === "missing") throw new ArtifactReadError("File not found", 410, "ARTIFACT_MISSING");
      if (row.kind === "image") return { kind: "image", blob: new Blob([PNG_1X1], { type: "image/png" }) };
      if (row.displayPath.endsWith(".html")) {
        return { kind: "text", body: "<h1>Design notes</h1><p>Rendered through the sandboxed preview.</p>" };
      }
      return { kind: "text", body: `# ${row.displayPath.split("/").pop()}\n\nSort chunks as they arrive, then merge.\n` };
    },
  };
}
