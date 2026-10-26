import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import {
  cancelUpdate,
  installUpdate,
  restartDaemon,
  setAutoCheck,
  skipUpdate,
  unskipUpdate,
} from "./update";

/** Stubs `fetch` (not the module) with the daemon's real JSON error bodies. */
function stubFetch(status: number, body?: unknown) {
  const fn = vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const IMPACT = [{ sessionId: "s1", kind: "working" }];

describe("restartDaemon (real response shapes)", () => {
  it("202 -> accepted", async () => {
    stubFetch(202, { ok: true });
    expect(await restartDaemon({})).toEqual({ kind: "accepted" });
  });

  it("200 dry-run -> impact", async () => {
    stubFetch(200, { impact: IMPACT });
    expect(await restartDaemon({ dryRun: true })).toEqual({ kind: "impact", impact: IMPACT });
  });

  it("409 restart_busy -> busy with impact", async () => {
    stubFetch(409, { error: "restart_busy", impact: IMPACT });
    expect(await restartDaemon({})).toEqual({ kind: "busy", impact: IMPACT });
  });

  it.each(["tauri_hosted", "update_in_progress", "restart_in_progress"])(
    "409 %s -> error with that code",
    async (code) => {
      stubFetch(409, { error: code });
      expect(await restartDaemon({})).toEqual({ kind: "error", code });
    },
  );

  it("403 mobile_read_only -> error with that code", async () => {
    stubFetch(403, { error: "mobile_read_only" });
    expect(await restartDaemon({})).toEqual({ kind: "error", code: "mobile_read_only" });
  });

  it("non-JSON failure falls back to http_<status>", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 502 })));
    expect(await restartDaemon({})).toEqual({ kind: "error", code: "http_502" });
  });
});

describe("update mutators surface the daemon `error` as ApiError.code", () => {
  it("installUpdate 422 no_asset carries code and message", async () => {
    stubFetch(422, { error: "no_asset", message: "No update is available" });
    const err = await installUpdate().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: "no_asset", message: "No update is available" });
  });

  it("installUpdate 409 restart_in_progress throws instead of refetching", async () => {
    const fn = stubFetch(409, { error: "restart_in_progress" });
    await expect(installUpdate()).rejects.toMatchObject({ status: 409, code: "restart_in_progress" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("installUpdate 409 update_in_progress returns the running snapshot", async () => {
    const snapshot = { current: "1.0.0", install: { stage: "downloading", pct: 5, startedBy: "cli" } };
    const fn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "update_in_progress", startedBy: "cli" }), { status: 409 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200 }));
    vi.stubGlobal("fetch", fn);
    expect(await installUpdate()).toEqual(snapshot);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancelUpdate 409 not_cancellable", async () => {
    stubFetch(409, { error: "not_cancellable" });
    await expect(cancelUpdate()).rejects.toMatchObject({ status: 409, code: "not_cancellable" });
  });

  it.each([
    ["skipUpdate", () => skipUpdate("1.2.3")],
    ["unskipUpdate", () => unskipUpdate("1.2.3")],
    ["setAutoCheck", () => setAutoCheck(true)],
  ])("%s 403 mobile_read_only", async (_name, call) => {
    stubFetch(403, { error: "mobile_read_only" });
    await expect(call()).rejects.toMatchObject({ status: 403, code: "mobile_read_only" });
  });

  it("2xx still parses the snapshot", async () => {
    stubFetch(200, { current: "1.0.0" });
    expect(await skipUpdate("1.2.3")).toEqual({ current: "1.0.0" });
  });
});
