import { getDaemonUrl } from "./daemon-url.js";
import { die } from "./output.js";

export type DaemonResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; conflictWith?: unknown };

async function daemonRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<DaemonResult<T>> {
  const url = getDaemonUrl();
  if (!url) {
    die("Daemon is not running. Run `vrun daemon start`.", 4);
  }

  try {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      return { ok: true, status: response.status, data: data as T };
    }

    const result: DaemonResult<T> = {
      ok: false,
      status: response.status,
      error: (data as Record<string, unknown>).error as string,
    };
    if ((data as Record<string, unknown>).conflictWith) {
      (result as Record<string, unknown>).conflictWith = (data as Record<string, unknown>).conflictWith;
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ECONNREFUSED") || message.includes("connect")) {
      die("Daemon is not running. Run `vrun daemon start`.", 4);
    }
    throw err;
  }
}

export async function daemonGet<T>(path: string): Promise<DaemonResult<T>> {
  return daemonRequest<T>("GET", path);
}

export async function daemonPost<T>(
  path: string,
  body?: unknown
): Promise<DaemonResult<T>> {
  return daemonRequest<T>("POST", path, body);
}

export async function daemonPut<T>(
  path: string,
  body?: unknown
): Promise<DaemonResult<T>> {
  return daemonRequest<T>("PUT", path, body);
}

export async function daemonDelete<T>(path: string): Promise<DaemonResult<T>> {
  return daemonRequest<T>("DELETE", path);
}
