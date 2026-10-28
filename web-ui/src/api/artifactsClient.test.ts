import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClientApi } from "./client";
import { ArtifactReadError } from "./errors";

vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });

let fetchMock: ReturnType<typeof vi.fn>;
type Call = [input: string, init?: RequestInit];

function res(status: number, body: string | Blob, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: h,
    json: async () => JSON.parse(body as string),
    text: async () => (typeof body === "string" ? body : ""),
    blob: async () => (body instanceof Blob ? body : new Blob([body])),
  };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("artifact client methods (6.T3)", () => {
  it("listArtifacts hits the worktree and project routes", async () => {
    fetchMock.mockResolvedValue(res(200, JSON.stringify({ rev: 1, cap: 500, total: 0, items: [] })));
    const api = createClientApi();
    await api.listArtifacts("w 1", "worktree");
    await api.listArtifacts("p1", "project");
    expect((fetchMock.mock.calls[0] as Call)[0]).toBe("/api/worktrees/w%201/artifacts");
    expect((fetchMock.mock.calls[1] as Call)[0]).toBe("/api/projects/p1/artifacts");
  });

  it("pinArtifact POSTs {pinned} and unwraps the row; removeArtifact DELETEs", async () => {
    fetchMock.mockResolvedValueOnce(res(200, JSON.stringify({ artifact: { id: "a" } })));
    fetchMock.mockResolvedValueOnce(res(200, JSON.stringify({ ok: true })));
    const api = createClientApi();
    expect(await api.pinArtifact("a", true)).toEqual({ id: "a" });
    const [url, init] = fetchMock.mock.calls[0] as Call;
    expect(url).toBe("/api/artifacts/a/pin");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ pinned: true });
    await api.removeArtifact("a");
    const [url2, init2] = fetchMock.mock.calls[1] as Call;
    expect(url2).toBe("/api/artifacts/a");
    expect(init2?.method).toBe("DELETE");
  });

  it("getArtifactContent returns text and parses the truncation header", async () => {
    fetchMock.mockResolvedValueOnce(res(200, "hello", { "content-type": "text/plain; charset=utf-8" }));
    fetchMock.mockResolvedValueOnce(res(200, "hel", { "content-type": "text/plain", "x-vst-truncated-total": "2500000" }));
    const api = createClientApi();
    expect(await api.getArtifactContent("a")).toEqual({ kind: "text", body: "hello" });
    expect(await api.getArtifactContent("a")).toEqual({ kind: "text", body: "hel", truncatedTotal: 2_500_000 });
  });

  it("getArtifactContent returns a blob for image responses", async () => {
    fetchMock.mockResolvedValue(res(200, new Blob(["x"], { type: "image/png" }), { "content-type": "image/png" }));
    const out = await createClientApi().getArtifactContent("a");
    expect(out.kind).toBe("image");
  });

  it.each([
    [404, "ARTIFACT_NOT_FOUND", {}],
    [410, "ARTIFACT_MISSING", {}],
    [403, "ARTIFACT_DENIED", {}],
    [403, "ARTIFACT_UNREADABLE", { detail: "EACCES" }],
    [415, "ARTIFACT_BINARY", { size: 12, mime: "application/zip" }],
    [422, "ARTIFACT_TOO_LARGE", { size: 99 }],
  ])("maps %s %s to a typed ArtifactReadError", async (status, code, extra) => {
    fetchMock.mockResolvedValue(res(status, JSON.stringify({ error: code, message: "m", ...extra })));
    const err = await createClientApi().getArtifactContent("a").catch((e) => e);
    expect(err).toBeInstanceOf(ArtifactReadError);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(err.info).toEqual(extra);
  });

  it("a non-JSON error body keeps the raw text and no code", async () => {
    fetchMock.mockResolvedValue(res(500, "oops"));
    const err = await createClientApi().getArtifactContent("a").catch((e) => e);
    expect(err).toBeInstanceOf(ArtifactReadError);
    expect(err.message).toBe("oops");
    expect(err.code).toBeUndefined();
  });
});
