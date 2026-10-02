import { describe, it, expect } from "vitest";
import {
  failureHeadline,
  isLspNotReady,
  isLspDisabled,
  isLspUnsupported,
  lspFailureFromError,
  type LspFailure,
} from "./lspApi";
import { ApiError } from "@/api/errors";

describe("lspApi error helpers (Bug 11)", () => {
  it("isLspDisabled returns true for 409 LSP_DISABLED", () => {
    const err = new ApiError(JSON.stringify({ error: "Code navigation is disabled", code: "LSP_DISABLED" }), 409);
    expect(isLspDisabled(err)).toBe(true);
    expect(isLspNotReady(err)).toBe(false);
  });

  it("isLspDisabled returns true for object with code LSP_DISABLED", () => {
    expect(isLspDisabled({ code: "LSP_DISABLED", status: 409 })).toBe(true);
    expect(isLspNotReady({ code: "LSP_DISABLED", status: 409 })).toBe(false);
  });

  it("isLspUnsupported returns true for 422 LSP_UNSUPPORTED", () => {
    const err = new ApiError(JSON.stringify({ error: "unsupported", code: "LSP_UNSUPPORTED" }), 422);
    expect(isLspUnsupported(err)).toBe(true);
    expect(isLspNotReady(err)).toBe(false);
  });

  it("isLspNotReady returns true for 409 LSP_NOT_READY", () => {
    const err = new ApiError(JSON.stringify({ error: "still starting", code: "LSP_NOT_READY" }), 409);
    expect(isLspNotReady(err)).toBe(true);
    expect(isLspDisabled(err)).toBe(false);
  });

  it("isLspNotReady returns true for plain 409 without disabled code", () => {
    const err = new ApiError("409 Conflict", 409);
    expect(isLspNotReady(err)).toBe(true);
  });

  it("isLspNotReady returns false for other errors", () => {
    expect(isLspNotReady(new Error("Generic error"))).toBe(false);
    expect(isLspNotReady(new ApiError("Not found", 404))).toBe(false);
  });
});

describe("LSP_SERVER_FAILED (503) failure payload", () => {
  const failure: LspFailure = {
    kind: "missing_dependency",
    summary: "TypeScript isn't installed for this project — code navigation needs it.",
    message: "Request initialize failed with message: Could not find a valid TypeScript installation.",
    exitCode: null,
    remediation: [
      { kind: "copy_command", label: "Copy install command", command: 'npm i -D "typescript@<7"' },
      { kind: "retry", label: "Retry" },
    ],
    autoRetry: true,
  };
  const body = { error: failure.summary, code: "LSP_SERVER_FAILED", failure };

  it("lspFailureFromError parses the 503 body thrown by parseJson", () => {
    const err = new ApiError(JSON.stringify(body), 503);
    expect(lspFailureFromError(err)).toEqual(failure);
  });

  it("lspFailureFromError accepts an already-parsed body", () => {
    expect(lspFailureFromError(body)).toEqual(failure);
  });

  it("lspFailureFromError is null for other errors", () => {
    expect(lspFailureFromError(new ApiError(JSON.stringify({ error: "x", code: "LSP_NOT_READY" }), 409))).toBeNull();
    expect(lspFailureFromError(new ApiError("Internal Server Error", 500))).toBeNull();
    expect(lspFailureFromError(new ApiError(JSON.stringify({ code: "LSP_SERVER_FAILED" }), 503))).toBeNull();
    expect(lspFailureFromError(null)).toBeNull();
  });

  it("isLspNotReady is false on LSP_SERVER_FAILED, so it is never retried as 'still starting'", () => {
    const err = new ApiError(JSON.stringify(body), 503);
    expect(isLspNotReady(err)).toBe(false);
    expect(isLspDisabled(err)).toBe(false);
    expect(isLspUnsupported(err)).toBe(false);
  });

  it("failureHeadline trims the summary to its lead clause", () => {
    expect(failureHeadline(failure)).toBe("TypeScript isn't installed for this project");
    expect(
      failureHeadline({ ...failure, summary: "typescript-language-server failed to start: Could not find it." }),
    ).toBe("typescript-language-server failed to start");
    expect(
      failureHeadline({
        ...failure,
        summary:
          "This project's TypeScript 7.0.2 has no tsserver, which typescript-language-server requires. Install TypeScript 6 or earlier.",
      }),
    ).toBe("This project's TypeScript 7.0.2 has no tsserver, which typescript-language-server requires");
  });
});
