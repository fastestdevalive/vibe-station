import type { CommitLogEntry } from "@/api/types";

/** Relative time like "3m ago", "2h ago", "5d ago"; falls back to a date past ~30d. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/**
 * The branch's own commits, split out of a (most-recent-first) page at the
 * first `isOnBranch: false` entry. Everything from there down is base-branch /
 * upstream history. A branch that merged the base back in partway can
 * interleave `isOnBranch: true` commits after that point; those still get
 * bucketed as upstream here, which is an acceptable simplification for this
 * view (they're still visible, just grouped under "from <base>").
 */
export function splitOwnCommits(page: CommitLogEntry[]): CommitLogEntry[] {
  const splitIdx = page.findIndex((c) => !c.isOnBranch);
  return splitIdx === -1 ? page : page.slice(0, splitIdx);
}
