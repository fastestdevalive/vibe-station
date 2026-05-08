import { getDaemonToken, getDaemonUrl } from "./daemon-url.js";
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
    die("Daemon is not running. Run `vst daemon start`.", 4);
  }

  try {
    // Only set Content-Type when we actually have a body. Fastify rejects
    // empty bodies on application/json with FST_ERR_CTP_EMPTY_JSON_BODY,
    // which broke `vst worktree rm` (DELETE without body).
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";

    // Add Bearer token if the daemon has auth enabled
    const token = getDaemonToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const response = await fetch(`${url}${path}`, {
      method,
      headers,
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
      die("Daemon is not running. Run `vst daemon start`.", 4);
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
