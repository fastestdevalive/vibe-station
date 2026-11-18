import { beforeEach, describe, expect, it } from "vitest";
import { LEGACY_MIGRATION_MARKER, migrateLegacy, type LegacyImportTarget } from "./migrateLegacy";

function makeTarget(server: Record<string, string> = {}, globalPromptSnapshot: string | null = null) {
  const imported: Array<[string, string]> = [];
  const target: LegacyImportTarget = {
    globalPromptSnapshot,
    serverText: (scope) => server[scope] ?? "",
    importLocal: (scope, text) => {
      imported.push([scope, text]);
    },
  };
  return { imported, target };
}

function globalDraft(prompt: string, config: Record<string, unknown> = { entryPoint: "global" }) {
  return JSON.stringify({ state: { draft: { draftPrompt: prompt, draftConfig: config } }, version: 0 });
}

beforeEach(() => {
  localStorage.clear();
});

describe("migrateLegacy (Decision 7)", () => {
  it("imports_via_importLocal_when_server_empty", () => {
    localStorage.setItem("vst-chat-draft-s1", "hello");
    localStorage.setItem("vst-review-picker-draft:worktree:wt-1", "picker message");
    const { imported, target } = makeTarget();

    migrateLegacy(target);

    expect(imported).toEqual([
      ["s1", "hello"],
      ["review-picker:worktree:wt-1", "picker message"],
    ]);
  });

  it("skips_when_server_has_text", () => {
    localStorage.setItem("vst-chat-draft-s1", "stale local");
    const { imported, target } = makeTarget({ s1: "server text" });

    migrateLegacy(target);

    expect(imported).toEqual([]);
  });

  it("removes_keys_and_sets_marker", () => {
    localStorage.setItem("vst-chat-draft-s1", "hello");
    localStorage.setItem("vst-review-picker-draft:project:p1", "picker");
    const { target } = makeTarget();

    migrateLegacy(target);

    expect(localStorage.getItem("vst-chat-draft-s1")).toBeNull();
    expect(localStorage.getItem("vst-review-picker-draft:project:p1")).toBeNull();
    expect(localStorage.getItem(LEGACY_MIGRATION_MARKER)).toBe("1");
  });

  it("never_reruns_after_marker", () => {
    localStorage.setItem(LEGACY_MIGRATION_MARKER, "1");
    localStorage.setItem("vst-chat-draft-s9", "leftover");
    const { imported, target } = makeTarget();

    migrateLegacy(target);

    expect(imported).toEqual([]);
    expect(localStorage.getItem("vst-chat-draft-s9")).toBe("leftover");
  });

  it("global_draft_keeps_config_drops_prompt", () => {
    localStorage.setItem("vst-global-draft", globalDraft("typed prompt"));
    const { imported, target } = makeTarget({}, "typed prompt");

    migrateLegacy(target);

    expect(imported).toEqual([["global-new", "typed prompt"]]);
    const stored = JSON.parse(localStorage.getItem("vst-global-draft") ?? "{}") as {
      state?: { draft?: { draftPrompt?: string; draftConfig?: unknown } };
    };
    expect(stored.state?.draft?.draftPrompt).toBe("");
    expect(stored.state?.draft?.draftConfig).toEqual({ entryPoint: "global" });
  });
});
