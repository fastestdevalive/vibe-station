/**
 * Update + restart REST calls. Plain functions over `apiFetch` (not `ApiInstance`
 * methods), so they have no mock/demo implementation.
 */
import { apiFetch, baseUrl, parseJson } from "./client";
import { ApiError } from "./errors";
import type { ImpactItem, UpdateApiError, UpdateApiErrorCode, UpdateCheckResponse, UpdateStatus } from "./types";

/** Outcome of `POST /daemon/restart`. */
export type RestartOutcome =
  | { kind: "accepted" }
  | { kind: "impact"; impact: ImpactItem[] }
  | { kind: "busy"; impact: ImpactItem[] }
  | { kind: "error"; code: UpdateApiErrorCode | `http_${number}` };

/**
 * `POST /daemon/restart` — request daemon restart.
 */
export async function restartDaemon(body: {
  confirm?: boolean;
  dryRun?: boolean;
}): Promise<RestartOutcome> {
  const res = await apiFetch(`${baseUrl()}/daemon/restart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 202) {
    return { kind: "accepted" };
  }

  // NOT `parseJson`: it throws on every non-2xx, which would drop the
  // `{ error, impact }` body the daemon sends with 409/403.
  const json: Partial<UpdateApiError> = await res.json().catch(() => ({}));

  if (res.status === 200 && json.impact) {
    return { kind: "impact", impact: json.impact };
  }

  if (res.status === 409 && json.error === "restart_busy" && json.impact) {
    return { kind: "busy", impact: json.impact };
  }

  return { kind: "error", code: json.error ?? `http_${res.status}` };
}

/**
 * Throw an `ApiError` for a non-2xx update response. The update routes reply
 * `{ "error": "<code>", "message"?: "..." }` (not `{ code }`), so `ApiError.code`
 * must come from `error` for callers to map it to recovery copy.
 */
async function updateError(res: Response): Promise<never> {
  const body: Partial<UpdateApiError> = await res.json().catch(() => ({}));
  throw new ApiError(body.message ?? body.error ?? res.statusText, res.status, body.error);
}

async function updateJson<T>(res: Response): Promise<T> {
  if (!res.ok) return updateError(res);
  return res.json() as Promise<T>;
}

/** `GET /update/check` — `force` bypasses the 3-day throttle (30 s floor server-side). */
export async function fetchUpdateStatus(force: boolean): Promise<UpdateCheckResponse> {
  const res = await apiFetch(`${baseUrl()}/update/check?force=${force ? "true" : "false"}`);
  return parseJson<UpdateCheckResponse>(res);
}

/** `POST /update/settings` — persist the auto-check toggle. */
export async function setAutoCheck(on: boolean): Promise<UpdateStatus> {
  const res = await apiFetch(`${baseUrl()}/update/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoCheck: on }),
  });
  return updateJson<UpdateStatus>(res);
}

/**
 * `POST /update/install` — trigger update install.
 * 409 `update_in_progress` re-fetches and returns the running snapshot; any other
 * failure throws an `ApiError` whose `code` is the daemon `error` field.
 */
export async function installUpdate(): Promise<UpdateStatus> {
  const res = await apiFetch(`${baseUrl()}/update/install`, {
    method: "POST",
  });
  if (res.status === 409) {
    const body: Partial<UpdateApiError> = await res
      .clone()
      .json()
      .catch(() => ({}));
    // Only `update_in_progress` means "someone already started it": jump to
    // the running snapshot. `restart_in_progress` etc. are real errors.
    if (body.error === "update_in_progress") {
      return fetchUpdateStatus(false);
    }
  }
  return updateJson<UpdateStatus>(res);
}

/** `POST /update/cancel` — cancel in-flight download. */
export async function cancelUpdate(): Promise<UpdateStatus> {
  const res = await apiFetch(`${baseUrl()}/update/cancel`, {
    method: "POST",
  });
  return updateJson<UpdateStatus>(res);
}

/** `POST /update/skip` — skip specified version. */
export async function skipUpdate(version: string): Promise<UpdateStatus> {
  const res = await apiFetch(`${baseUrl()}/update/skip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version }),
  });
  return updateJson<UpdateStatus>(res);
}

/** `POST /update/unskip` — unskip specified version. */
export async function unskipUpdate(version: string): Promise<UpdateStatus> {
  const res = await apiFetch(`${baseUrl()}/update/unskip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version }),
  });
  return updateJson<UpdateStatus>(res);
}
