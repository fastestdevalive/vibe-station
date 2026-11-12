import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { OUTLINE_UNAVAILABLE, OUTLINE_UNSUPPORTED, createTranscriptOutlineClient } from "./transcriptOutlineClient";

const SUMMARY = { ready: true, totalTurns: 0, revision: "0", bucketSize: 1, tools: [], edits: [], errors: [] };
const JSON_HEADERS = { "Content-Type": "application/json" };

function setup(response: () => Response) {
  const apiFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => response());
  const client = createTranscriptOutlineClient({ baseUrl: () => "/api", apiFetch });
  return { apiFetch, client };
}

async function rejectionOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected a rejection");
}

describe("getTranscriptOutline", () => {
  it("resolves to the summary body with the encoded URL and no init when unsigned", async () => {
    const { client, apiFetch } = setup(() => new Response(JSON.stringify(SUMMARY), { status: 200, headers: JSON_HEADERS }));
    await expect(client.getTranscriptOutline("s 1")).resolves.toEqual(SUMMARY);
    expect(apiFetch.mock.calls[0]).toEqual(["/api/sessions/s%201/transcript/outline", undefined]);
  });

  it("passes the AbortSignal to apiFetch", async () => {
    const { client, apiFetch } = setup(() => new Response(JSON.stringify(SUMMARY), { status: 200, headers: JSON_HEADERS }));
    const ac = new AbortController();
    await client.getTranscriptOutline("s1", ac.signal);
    expect(apiFetch.mock.calls[0]?.[1]).toEqual({ signal: ac.signal });
  });

  it("a 200 text/html response (SPA fallback) rejects as OUTLINE_UNSUPPORTED", async () => {
    const { client } = setup(() => new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    const err = await rejectionOf(client.getTranscriptOutline("s1"));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe(OUTLINE_UNSUPPORTED);
  });

  it("a JSON body without the tools/edits/errors arrays rejects as OUTLINE_UNSUPPORTED", async () => {
    const { client } = setup(
      () => new Response(JSON.stringify({ ready: true, totalTurns: 3, revision: "0" }), { status: 200, headers: JSON_HEADERS }),
    );
    const err = await rejectionOf(client.getTranscriptOutline("s1"));
    expect(err.code).toBe(OUTLINE_UNSUPPORTED);
  });

  it("keeps a daemon error code", async () => {
    const { client } = setup(
      () => new Response(JSON.stringify({ error: "x", code: "NOT_FOUND" }), { status: 404, headers: JSON_HEADERS }),
    );
    const err = await rejectionOf(client.getTranscriptOutline("s1"));
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("a plain-text 404 carries no code", async () => {
    const { client } = setup(() => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } }));
    const err = await rejectionOf(client.getTranscriptOutline("s1"));
    expect(err.status).toBe(404);
    expect(err.code).toBeUndefined();
  });

  it("keeps the OUTLINE_UNAVAILABLE code of a 503", async () => {
    const { client } = setup(
      () => new Response(JSON.stringify({ error: "off", code: OUTLINE_UNAVAILABLE }), { status: 503, headers: JSON_HEADERS }),
    );
    const err = await rejectionOf(client.getTranscriptOutline("s1"));
    expect(err.status).toBe(503);
    expect(err.code).toBe(OUTLINE_UNAVAILABLE);
  });
});

describe("getTranscriptOutlineWindow", () => {
  const WINDOW = { ready: true, totalTurns: 1, revision: "0", from: 40, turns: [] };

  it("requests from and limit, and omits limit when not given", async () => {
    const { client, apiFetch } = setup(() => new Response(JSON.stringify(WINDOW), { status: 200, headers: JSON_HEADERS }));
    await expect(client.getTranscriptOutlineWindow("s 1", { from: 40, limit: 20 })).resolves.toEqual(WINDOW);
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/sessions/s%201/transcript/outline/window?from=40&limit=20");

    await client.getTranscriptOutlineWindow("s1", { from: 0 });
    expect(apiFetch.mock.calls[1]?.[0]).toBe("/api/sessions/s1/transcript/outline/window?from=0");
  });

  it("a non-JSON 200 or a body without turns rejects as OUTLINE_UNSUPPORTED", async () => {
    const html = setup(() => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    expect((await rejectionOf(html.client.getTranscriptOutlineWindow("s1", { from: 0 }))).code).toBe(OUTLINE_UNSUPPORTED);
    const shapeless = setup(() => new Response("{}", { status: 200, headers: JSON_HEADERS }));
    expect((await rejectionOf(shapeless.client.getTranscriptOutlineWindow("s1", { from: 0 }))).code).toBe(OUTLINE_UNSUPPORTED);
  });
});
