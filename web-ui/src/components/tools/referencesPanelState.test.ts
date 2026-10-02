import { describe, expect, it } from "vitest";
import type { LspFailure, LspFailureKind } from "@/lib/lspApi";
import { chipFor, derivePanelState, fallbackReasonText, headerActionFor, type PanelInputs } from "./referencesPanelState";

const base: PanelInputs = {
  query: { symbol: "sym", intent: "references" },
  outcome: { kind: "done" },
  loadingMore: false,
  totalCount: 0,
  hasMore: false,
  allText: false,
  fallback: null,
  lspStatus: "ready",
  degraded: null,
  failure: null,
};
const ctx = { serverName: "Rust", lspStatus: "ready" as const };

describe("derivePanelState", () => {
  it("S0: no query is empty, with no chip and no header action", () => {
    const st = derivePanelState({ ...base, query: null });
    expect(st).toEqual({ kind: "empty" });
    expect(chipFor(st, ctx)).toBeNull();
    expect(headerActionFor(st)).toBeNull();
  });

  it("S2: cancelled is its own state, never zero results", () => {
    const st = derivePanelState({ ...base, outcome: { kind: "cancelled" } });
    expect(st.kind).toBe("cancelled");
    expect(headerActionFor(st)).toBe("refresh");
  });

  it("S10 vs S7: zero results map to not_found only when the server is missing", () => {
    expect(derivePanelState(base).kind).toBe("no_results");
    expect(derivePanelState({ ...base, lspStatus: "not_found" }).kind).toBe("not_found");
    expect(derivePanelState({ ...base, fallback: "not_found" }).kind).toBe("not_found");
  });

  it("S13: results stay results while loading more; the chip is unchanged", () => {
    const st = derivePanelState({ ...base, totalCount: 3, hasMore: true, loadingMore: true });
    expect(st).toMatchObject({ kind: "results", loadingMore: true });
    expect(chipFor(st, { ...ctx, lspStatus: "indexing" })?.word).toBe("LSP");
    expect(headerActionFor(st)).toBe("cancel");
  });

  it("S12: a response-level fallback marks results text-only even if rows say lsp", () => {
    const st = derivePanelState({ ...base, totalCount: 2, fallback: "starting" });
    expect(st).toMatchObject({ kind: "results", textOnly: true });
    expect(chipFor(st, ctx)).toMatchObject({ tone: "warn", word: "Text" });
  });

  it("S15: degraded results are Partial", () => {
    const st = derivePanelState({ ...base, totalCount: 2, degraded: "cargo metadata failed" });
    expect(chipFor(st, ctx)).toMatchObject({ tone: "warn", word: "Partial" });
  });

  it("S16: a no-definition query is no_definition whether or not it has run", () => {
    const q = { symbol: "oneshot", intent: "no-definition" as const };
    expect(derivePanelState({ ...base, query: q, outcome: { kind: "idle" } }).kind).toBe("no_definition");
    expect(derivePanelState({ ...base, query: q }).kind).toBe("no_definition");
    expect(chipFor(derivePanelState({ ...base, query: q }), ctx)?.word).toBe("LSP");
  });

  it("S3: starting while retrying shows a spinner chip and a cancel action", () => {
    const st = derivePanelState({ ...base, outcome: { kind: "starting", attempt: 2, retrying: true } });
    expect(chipFor(st, { ...ctx, lspStatus: "starting" })).toMatchObject({ word: "Starting", spinner: true });
    expect(chipFor(st, { ...ctx, lspStatus: "indexing" })?.word).toBe("Indexing");
    expect(headerActionFor(st)).toBe("cancel");
  });

  it("every chip word is a single short word (never a sentence)", () => {
    const states = [
      derivePanelState({ ...base, outcome: { kind: "loading" } }),
      derivePanelState({ ...base, outcome: { kind: "error", message: "x".repeat(500) } }),
      derivePanelState({ ...base, outcome: { kind: "disabled" } }),
      derivePanelState({ ...base, outcome: { kind: "unsupported" } }),
      derivePanelState({ ...base, lspStatus: "not_found" }),
    ];
    for (const st of states) {
      const chip = chipFor(st, ctx)!;
      expect(chip.word.length).toBeLessThanOrEqual(10);
      expect(chip.tooltip.length).toBeLessThanOrEqual(220);
    }
  });
});

function failureOf(kind: LspFailureKind): LspFailure {
  const dependency = kind === "missing_dependency" || kind === "incompatible_dependency";
  return {
    kind,
    summary: dependency
      ? "TypeScript isn't installed for this project — code navigation needs it."
      : "typescript-language-server failed to start: Could not find a valid TypeScript installation.",
    message: "Request initialize failed with message: Could not find a valid TypeScript installation.",
    remediation: dependency
      ? [
          { kind: "copy_command", label: "Copy install command", command: 'npm i -D "typescript@<7"' },
          { kind: "retry", label: "Retry" },
        ]
      : [{ kind: "retry", label: "Retry" }],
    autoRetry: false,
  };
}

describe("S17 server_failed", () => {
  const kinds: LspFailureKind[] = [
    "missing_dependency",
    "incompatible_dependency",
    "init_failed",
    "exited_on_start",
    "init_timeout",
    "crashed",
    "spawn_failed",
  ];
  const isDep = (k: LspFailureKind) => k === "missing_dependency" || k === "incompatible_dependency";
  const sfQuery = { symbol: "sym", intent: "references" as const };
  const ndQuery = { symbol: "sym", intent: "no-definition" as const };

  for (const kind of kinds) {
    const failure = failureOf(kind);
    const wantChip = isDep(kind) ? { tone: "warn", word: "Setup" } : { tone: "error", word: "Error" };

    it(`${kind}: a 503 (no fallback possible) is S17 with ${wantChip.word}, refresh action`, () => {
      const st = derivePanelState({ ...base, query: sfQuery, outcome: { kind: "server_failed", failure } });
      expect(st).toEqual({ kind: "server_failed", failure });
      expect(chipFor(st, ctx)).toMatchObject({ ...wantChip, tooltip: failure.summary });
      expect(headerActionFor(st)).toBe("refresh");
    });

    it(`${kind}: text fallback with hits > 0 is Text results carrying the failure`, () => {
      const st = derivePanelState({ ...base, totalCount: 4, allText: true, fallback: "server_failed", failure });
      expect(st).toMatchObject({ kind: "results", textOnly: true, failure });
      const chip = chipFor(st, ctx)!;
      expect(chip).toMatchObject({ tone: "warn", word: "Text" });
      expect(chip.tooltip).toMatch(/— showing text matches \(may include unrelated hits\)$/);
      expect(chip.tooltip.startsWith(fallbackReasonText("server_failed", null, failure))).toBe(true);
    });

    it(`${kind}: text fallback with 0 hits is no_results carrying the failure`, () => {
      const st = derivePanelState({ ...base, fallback: "server_failed", failure });
      expect(st).toEqual({ kind: "no_results", fallback: "server_failed", failure });
      expect(chipFor(st, ctx)).toMatchObject({ tone: "warn", word: "Text" });
    });

    it(`${kind}: a no-definition query whose server never ran is S17, not S16`, () => {
      for (const outcome of [{ kind: "idle" as const }, { kind: "done" as const }]) {
        expect(derivePanelState({ ...base, query: ndQuery, outcome, failure })).toEqual({
          kind: "server_failed",
          failure,
        });
      }
    });
  }

  it("a stale polled failure never relabels a real LSP answer", () => {
    const failure = failureOf("missing_dependency");
    expect(derivePanelState({ ...base, totalCount: 3, failure })).toMatchObject({ kind: "results", failure: null });
    expect(derivePanelState({ ...base, failure })).toEqual({ kind: "no_results", fallback: null, failure: null });
  });

  it("server_failed without a known failure falls back to generic copy", () => {
    expect(fallbackReasonText("server_failed")).toBe("Language server failed to start");
    expect(fallbackReasonText("server_failed", null, failureOf("missing_dependency"))).toBe(
      "TypeScript isn't installed for this project",
    );
  });
});
