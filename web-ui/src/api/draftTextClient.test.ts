import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createDraftTextClient } from "./draftTextClient";

const JSON_HEADERS = { "Content-Type": "application/json" };
const DOC = { scope: "s1", text: "hi", revision: 3, updatedAt: "2026-01-01T00:00:00.000Z", clientId: "c1" };

function setup(response: () => Response) {
  const apiFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => response());
  const client = createDraftTextClient({ baseUrl: () => "/api", apiFetch });
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

describe("draftTextClient", () => {
  it("put_url_body_keepalive", async () => {
    const { client, apiFetch } = setup(() => new Response(JSON.stringify(DOC), { status: 200, headers: JSON_HEADERS }));
    await expect(client.putDraftText("s 1", "hi", "c1")).resolves.toEqual(DOC);
    expect(apiFetch.mock.calls[0]).toEqual([
      "/api/draft-texts/s%201",
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi", clientId: "c1" }) },
    ]);

    await client.putDraftText("s1", "hi", "c1", { keepalive: true });
    expect(apiFetch.mock.calls[1]?.[1]?.keepalive).toBe(true);
    expect(apiFetch.mock.calls[0]?.[1]?.keepalive).toBeUndefined();
  });

  it("413_maps_to_ApiError_code", async () => {
    const { client } = setup(
      () =>
        new Response(JSON.stringify({ code: "draft_too_large", limit: 65536 }), {
          status: 413,
          headers: JSON_HEADERS,
        }),
    );
    const err = await rejectionOf(client.putDraftText("s1", "x", "c1"));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(413);
    expect(err.code).toBe("draft_too_large");
  });

  it("keeps a daemon `error` code and a plain-text status without one", async () => {
    const withCode = setup(
      () => new Response(JSON.stringify({ error: "scope_not_found" }), { status: 404, headers: JSON_HEADERS }),
    );
    expect((await rejectionOf(withCode.client.getDraftText("gone"))).code).toBe("scope_not_found");

    const plain = setup(() => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } }));
    const err = await rejectionOf(plain.client.getDraftText("gone"));
    expect(err.status).toBe(404);
    expect(err.code).toBeUndefined();
  });

  it("lists the drafts array and gets one encoded doc", async () => {
    const { client, apiFetch } = setup(
      () => new Response(JSON.stringify({ drafts: [DOC] }), { status: 200, headers: JSON_HEADERS }),
    );
    await expect(client.listDraftTexts()).resolves.toEqual([DOC]);
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/draft-texts");

    const one = setup(() => new Response(JSON.stringify(DOC), { status: 200, headers: JSON_HEADERS }));
    await expect(one.client.getDraftText("a b")).resolves.toEqual(DOC);
    expect(one.apiFetch.mock.calls[0]?.[0]).toBe("/api/draft-texts/a%20b");
  });
});
