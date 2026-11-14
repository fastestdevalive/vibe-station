import { create } from "zustand";
import type { ChangedPathEntry, CommitLogEntry, FileScope } from "@/api/types";

/** Commit SHAs whose per-sha data (file list, diffs) stay cached: a full 40-hex SHA is immutable. */
export const MAX_SHAS = 200;
const FULL_SHA = /^[0-9a-f]{40}$/;

export const vcsKey = (scope: FileScope, id: string, submodule?: string): string =>
  `${scope}:${id}:${submodule ?? ""}`;

export type VcsStatus = "idle" | "loading" | "ready" | "error";

/** One commit-list entry. In-memory only: nothing here is persisted. */
export interface VcsCacheEntry {
  commits: CommitLogEntry[];
  pageLimit: number;
  status: VcsStatus;
  /** A revalidation request is in flight (the list shows the spinner only after a delay). */
  refreshing: boolean;
  /** Set by `worktree:head` / `ws:open` / `ws:resync`; the mounted list refetches when it flips true. */
  stale: boolean;
  fetchedAt: number | null;
  /** Last revalidation failure; rows stay visible when `status === "ready"`. */
  error?: string;
}

interface VcsCacheState {
  entries: Record<string, VcsCacheEntry>;
  /** Highest `rev` applied per worktree (`worktree:head` events with a lower rev are ignored). */
  headRevByWorktree: Record<string, number>;
  /** Creates the entry if absent. `cold` puts it in `loading` (no rows yet); otherwise rows stay and `refreshing` is set. */
  beginLoad: (key: string, opts: { cold: boolean; pageLimit: number }) => void;
  /** Stores a successful list. Keeps the array identity when the SHAs are unchanged. */
  replace: (key: string, commits: CommitLogEntry[], limit: number) => void;
  /** Failed load. With rows already `ready` they stay (error is set); otherwise the entry goes to `error`. */
  fail: (key: string, message: string) => void;
  markStale: (key: string) => void;
  markWorktreeStale: (worktreeId: string) => void;
  markAllStale: () => void;
  /** Applies a `worktree:head` observation; ignored unless `rev` is newer than the last applied one. */
  applyHead: (worktreeId: string, headSha: string | null, baseSha: string | null, rev: number) => void;
}

function worktreePrefix(worktreeId: string): string {
  return `worktree:${worktreeId}:`;
}

function setEntry(entries: Record<string, VcsCacheEntry>, key: string, patch: Partial<VcsCacheEntry>): Record<string, VcsCacheEntry> {
  const prev = entries[key] ?? emptyEntry();
  return { ...entries, [key]: { ...prev, ...patch } };
}

function emptyEntry(): VcsCacheEntry {
  return { commits: [], pageLimit: 0, status: "idle", refreshing: false, stale: false, fetchedAt: null };
}

function sameShas(a: CommitLogEntry[], b: CommitLogEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i]!.sha !== b[i]!.sha) return false;
  return true;
}

export const useVcsCacheStore = create<VcsCacheState>((set) => ({
  entries: {},
  headRevByWorktree: {},
  beginLoad: (key, { cold, pageLimit }) =>
    set((s) => {
      const prev = s.entries[key];
      if (!prev) return { entries: setEntry(s.entries, key, { pageLimit, status: "loading", refreshing: false }) };
      if (cold) return { entries: setEntry(s.entries, key, { status: "loading", refreshing: true, pageLimit }) };
      return { entries: setEntry(s.entries, key, { refreshing: true }) };
    }),
  replace: (key, commits, limit) =>
    set((s) => {
      const prev = s.entries[key];
      const keepArray = prev !== undefined && sameShas(prev.commits, commits);
      return {
        entries: setEntry(s.entries, key, {
          commits: keepArray ? prev.commits : commits,
          pageLimit: limit,
          status: "ready",
          refreshing: false,
          stale: false,
          fetchedAt: Date.now(),
          error: undefined,
        }),
      };
    }),
  fail: (key, message) =>
    set((s) => {
      const prev = s.entries[key];
      if (prev?.status === "ready") {
        return { entries: setEntry(s.entries, key, { error: message, refreshing: false, stale: false }) };
      }
      return { entries: setEntry(s.entries, key, { status: "error", error: message, refreshing: false, stale: false }) };
    }),
  markStale: (key) => set((s) => ({ entries: setEntry(s.entries, key, { stale: true }) })),
  markWorktreeStale: (worktreeId) =>
    set((s) => {
      const prefix = worktreePrefix(worktreeId);
      const entries = { ...s.entries };
      for (const key of Object.keys(entries)) {
        if (key.startsWith(prefix)) entries[key] = { ...entries[key]!, stale: true };
      }
      return { entries };
    }),
  markAllStale: () =>
    set((s) => {
      const entries: Record<string, VcsCacheEntry> = {};
      for (const [key, e] of Object.entries(s.entries)) entries[key] = { ...e, stale: true };
      return { entries };
    }),
  applyHead: (worktreeId, _headSha, _baseSha, rev) => {
    const prevRev = useVcsCacheStore.getState().headRevByWorktree[worktreeId] ?? -1;
    if (rev <= prevRev) return;
    set((s) => ({ headRevByWorktree: { ...s.headRevByWorktree, [worktreeId]: rev } }));
    useVcsCacheStore.getState().markWorktreeStale(worktreeId);
  },
}));

// ---- Per-sha LRU (file lists + diffs of one commit, immutable once the SHA is full-length) ----

interface ShaBucket {
  files?: ChangedPathEntry[];
  diffs: Map<string, string>;
}

const shaBuckets = new Map<string, ShaBucket>();

function bucketKey(key: string, sha: string): string {
  return `${key}\u0000${sha}`;
}

/** Returns the bucket for a full-length SHA, moving it to the most-recent end; undefined for short/invalid SHAs. */
function touchBucket(key: string, sha: string): ShaBucket | undefined {
  if (!FULL_SHA.test(sha)) return undefined;
  const k = bucketKey(key, sha);
  const bucket = shaBuckets.get(k);
  if (bucket) {
    shaBuckets.delete(k);
    shaBuckets.set(k, bucket);
  }
  return bucket;
}

function ensureBucket(key: string, sha: string): ShaBucket | undefined {
  if (!FULL_SHA.test(sha)) return undefined;
  const k = bucketKey(key, sha);
  let bucket = shaBuckets.get(k);
  if (!bucket) {
    bucket = { diffs: new Map() };
    shaBuckets.set(k, bucket);
  }
  shaBuckets.delete(k);
  shaBuckets.set(k, bucket);
  while (shaBuckets.size > MAX_SHAS) {
    const oldest = shaBuckets.keys().next().value;
    if (oldest === undefined) break;
    shaBuckets.delete(oldest);
  }
  return bucket;
}

export function getShaFiles(key: string, sha: string): ChangedPathEntry[] | undefined {
  return touchBucket(key, sha)?.files;
}

export function setShaFiles(key: string, sha: string, files: ChangedPathEntry[]): void {
  const bucket = ensureBucket(key, sha);
  if (bucket) bucket.files = files;
}

export function getShaDiff(key: string, sha: string, path: string): string | undefined {
  return touchBucket(key, sha)?.diffs.get(path);
}

export function setShaDiff(key: string, sha: string, path: string, diff: string): void {
  const bucket = ensureBucket(key, sha);
  if (bucket) bucket.diffs.set(path, diff);
}

/** Test seam: empties the store and the per-sha LRU. */
export function resetVcsCacheForTests(): void {
  useVcsCacheStore.setState({ entries: {}, headRevByWorktree: {} });
  shaBuckets.clear();
}
