/**
 * Per-project mutex.
 * Serializes all writes for a given project id.
 * Different projects can write concurrently.
 */

type Task<T> = () => Promise<T>;

class ProjectMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const mutexes = new Map<string, ProjectMutex>();

function getMutex(projectId: string): ProjectMutex {
  let m = mutexes.get(projectId);
  if (!m) {
    m = new ProjectMutex();
    mutexes.set(projectId, m);
  }
  return m;
}

/**
 * Run `fn` while holding the per-project mutex for `projectId`.
 * Serializes mutations within one project; different projects run in parallel.
 */
export async function withProjectLock<T>(projectId: string, fn: Task<T>): Promise<T> {
  const mutex = getMutex(projectId);
  await mutex.acquire();
  try {
    return await fn();
  } finally {
    mutex.release();
  }
}

/** For testing: remove a mutex so it can be garbage-collected. */
export function _releaseMutexForTest(projectId: string): void {
  mutexes.delete(projectId);
}
