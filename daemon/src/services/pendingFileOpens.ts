const queue = new Map<string, string[]>();

export function append(worktreeId: string, path: string): void {
  const paths = queue.get(worktreeId) ?? [];
  if (!paths.includes(path)) {
    paths.push(path);
    queue.set(worktreeId, paths);
  }
}

export function get(worktreeId: string): string[] {
  return queue.get(worktreeId) ?? [];
}

export function clear(worktreeId: string): void {
  queue.delete(worktreeId);
}
