/**
 * skill-invocation-in-chat REPLAN Phase 7A — daemon-side skill resolution +
 * directive formatting (7A.2-7A.6).
 *
 * `jsonAgent.ts`'s `resolveSkillInvocations` is the ONLY place that resolves
 * `{/name args}` tokens (or, via the v1 fallback, a leading `/name` line)
 * against the merged catalog (ACP + directory-scanned); the result is an
 * already-substituted message plus a list of already-resolved
 * `{name, args, path?}` structs. `claude.ts`'s `formatSkillDirective` only
 * FORMATS that list into the `<skill-invocations>` directive text — it
 * never touches the catalog.
 */
import { describe, it, expect } from "vitest";
import { formatSkillDirective } from "../agent-plugins/claude.js";
import { injectAttachments, resolveSkillInvocations } from "../services/jsonAgent.js";
import type { MergedSkillEntry } from "../services/userSkillCatalog.js";
import type { Attachment } from "../types.js";

describe("7A.4 — formatSkillDirective", () => {
  it("known skill + path + args → directive with 'Invoke the skill defined at' and 'with arguments:'", () => {
    const out = formatSkillDirective("/code-review high --fix\nand open a PR", [
      { name: "code-review", args: "high --fix", path: "/home/gb/.claude/skills/code-review/SKILL.md" },
    ]);
    expect(out).toContain("/code-review high --fix\nand open a PR");
    expect(out).toContain("<skill-invocations>");
    expect(out).toContain("Invoke the skill defined at /home/gb/.claude/skills/code-review/SKILL.md");
    expect(out).toContain("with arguments: high --fix");
    expect(out).toContain("</skill-invocations>");
  });

  it("known skill, no path (ACP-only) → 'Invoke the skill named `<name>`'", () => {
    const out = formatSkillDirective("/model haiku", [{ name: "model", args: "haiku" }]);
    expect(out).toContain("Invoke the skill named `model`");
    expect(out).not.toContain("Invoke the skill defined at");
  });

  it("known skill + no args → directive omits the 'with arguments:' line entirely", () => {
    const out = formatSkillDirective("/code-review", [
      { name: "code-review", args: "", path: "/skills/code-review/SKILL.md" },
    ]);
    expect(out).toContain("Invoke the skill defined at /skills/code-review/SKILL.md");
    expect(out).not.toContain("with arguments:");
  });

  it("empty / undefined skillInvocations → message unchanged, no block", () => {
    expect(formatSkillDirective("just a normal message", undefined)).toBe("just a normal message");
    expect(formatSkillDirective("just a normal message", [])).toBe("just a normal message");
  });

  it("the preamble states these are instructions to EXECUTE, not topics to discuss", () => {
    const out = formatSkillDirective("hi", [{ name: "simplify", args: "" }]);
    expect(out.toLowerCase()).toContain("execute");
  });

  it("N entries → ONE <skill-invocations> block listing all of them", () => {
    const out = formatSkillDirective("/code-review high --fix to do this. Also /simplify.", [
      { name: "code-review", args: "high --fix", path: "/skills/code-review/SKILL.md" },
      { name: "simplify", args: "" },
    ]);
    expect(out.match(/<skill-invocations>/g)).toHaveLength(1);
    expect(out).toContain("Invoke the skill defined at /skills/code-review/SKILL.md");
    expect(out).toContain("Invoke the skill named `simplify`");
  });
});

describe("7A.2/7A.3/7A.5 — resolveSkillInvocations", () => {
  const catalog: MergedSkillEntry[] = [
    { name: "code-review", description: "Review code", argumentHint: "[severity]", path: "/skills/code-review/SKILL.md" },
    { name: "model", description: "Switch model" }, // ACP-only — no path
    { name: "report", description: "Investigation report" },
    { name: "report-card", description: "Longer name sharing a prefix", path: "/skills/report-card/SKILL.md" },
    { name: "simplify", description: "Simplify" },
  ];

  describe("v1 fallback (7A.5) — message with NO tokens", () => {
    it("a name matching only an ACP entry (no directory path) yields path === undefined", () => {
      const result = resolveSkillInvocations("/model haiku", catalog);
      expect(result.message).toBe("/model haiku");
      expect(result.skillInvocations).toEqual([{ name: "model", args: "haiku" }]);
    });

    it("a name matching a directory entry yields the resolved absolute path", () => {
      const result = resolveSkillInvocations("/code-review high --fix\nand open a PR", catalog);
      expect(result.message).toBe("/code-review high --fix\nand open a PR");
      expect(result.skillInvocations).toEqual([
        { name: "code-review", args: "high --fix", path: "/skills/code-review/SKILL.md" },
      ]);
    });

    it("longest-match: '/report-card' resolves to report-card, not report", () => {
      const result = resolveSkillInvocations("/report-card please", catalog);
      expect(result.skillInvocations[0]?.name).toBe("report-card");
    });

    it("no matching name → message unchanged, no invocations (degrades to plain text, no error)", () => {
      expect(resolveSkillInvocations("/usr/local is full", catalog)).toEqual({
        message: "/usr/local is full",
        skillInvocations: [],
      });
      expect(resolveSkillInvocations("plain text, no leading slash", catalog)).toEqual({
        message: "plain text, no leading slash",
        skillInvocations: [],
      });
    });

    it("a skill removed from the catalog between send and run resolves to no invocations, not a throw", () => {
      const result = resolveSkillInvocations("/deleted-skill some args", catalog);
      expect(result.skillInvocations).toEqual([]);
      expect(result.message).toBe("/deleted-skill some args");
    });

    it("empty args when the name is followed immediately by a newline", () => {
      const result = resolveSkillInvocations("/code-review\nprose here", catalog);
      expect(result.skillInvocations).toEqual([
        { name: "code-review", args: "", path: "/skills/code-review/SKILL.md" },
      ]);
    });
  });

  describe("token grammar (7A.3) — inline substitution", () => {
    it("a plain unresolved-anything message with no tokens passes through unchanged", () => {
      const result = resolveSkillInvocations("hello world", catalog);
      expect(result).toEqual({ message: "hello world", skillInvocations: [] });
    });

    it("N tokens anywhere in prose substitute inline and produce N entries", () => {
      const result = resolveSkillInvocations(
        "Can you use {/code-review high --fix} to do this. Also use {/simplify}.",
        catalog,
      );
      expect(result.message).toBe("Can you use /code-review high --fix to do this. Also use /simplify.");
      expect(result.skillInvocations).toEqual([
        { name: "code-review", args: "high --fix", path: "/skills/code-review/SKILL.md" },
        { name: "simplify", args: "" },
      ]);
    });

    it("an unresolved token degrades to plain '/name args' text with NO directive entry", () => {
      const result = resolveSkillInvocations("Please run {/unknown-skill some args} now.", catalog);
      expect(result.message).toBe("Please run /unknown-skill some args now.");
      expect(result.skillInvocations).toEqual([]);
    });

    it("mixed resolved + unresolved tokens: only the resolved one gets an entry", () => {
      // offset-0 chip is RESOLVED here, so D7 also applies (see the dedicated
      // D7 tests below) — the natural word-boundary space becomes a newline.
      const result = resolveSkillInvocations("{/simplify} then {/nope args}", catalog);
      expect(result.message).toBe("/simplify\nthen /nope args");
      expect(result.skillInvocations).toEqual([{ name: "simplify", args: "" }]);
    });

    it("mixed resolved + unresolved tokens with a NON-offset-0 resolved chip: no D7 newline", () => {
      const result = resolveSkillInvocations("{/nope args} then {/simplify}", catalog);
      expect(result.message).toBe("/nope args then /simplify");
      expect(result.skillInvocations).toEqual([{ name: "simplify", args: "" }]);
    });

    it("ACP-only (path-less) entry form: ATP token resolves to an entry with no `path`", () => {
      const result = resolveSkillInvocations("Switch: {/model haiku}", catalog);
      expect(result.skillInvocations).toEqual([{ name: "model", args: "haiku" }]);
      expect(result.skillInvocations[0]).not.toHaveProperty("path");
    });

    it("D7: offset-0 RESOLVED chip followed by same-line prose forces a newline (prompt[0] compat)", () => {
      const result = resolveSkillInvocations("{/code-review high --fix} and open a PR", catalog);
      expect(result.message).toBe("/code-review high --fix\nand open a PR");
      expect(result.skillInvocations).toEqual([
        { name: "code-review", args: "high --fix", path: "/skills/code-review/SKILL.md" },
      ]);
    });

    it("D7 does not fire when the offset-0 chip is followed only by a newline already", () => {
      const result = resolveSkillInvocations("{/code-review high --fix}\nand open a PR", catalog);
      expect(result.message).toBe("/code-review high --fix\nand open a PR");
    });

    it("D7 does not fire when the offset-0 chip is UNRESOLVED", () => {
      const result = resolveSkillInvocations("{/unknown-skill args} and more text", catalog);
      expect(result.message).toBe("/unknown-skill args and more text");
      expect(result.skillInvocations).toEqual([]);
    });

    it("D7 does not fire when the offset-0 chip has nothing following it", () => {
      const result = resolveSkillInvocations("{/code-review high --fix}", catalog);
      expect(result.message).toBe("/code-review high --fix");
    });

    it("a mid-message resolved chip (not offset 0) never gets the D7 newline treatment", () => {
      const result = resolveSkillInvocations("prefix text {/simplify} and more", catalog);
      expect(result.message).toBe("prefix text /simplify and more");
    });
  });
});

describe("7A.6 — attachment hazard: resolved invocation + empty args + empty prose + attachment", () => {
  const attachment: Attachment = { id: "a1", name: "notes.txt", path: "/data/notes.txt", size: 10, mime: "text/plain" };

  it("line 1 stays '/name args', never becomes '[Attached files:]' alone", () => {
    const out = injectAttachments("/code-review", [attachment], /* hasResolvedInvocation */ true);
    expect(out.split("\n")[0]).toBe("/code-review");
    expect(out.startsWith("[Attached files:]")).toBe(false);
  });

  it("without a resolved invocation, a truly empty message still collapses to the header alone (unchanged behavior)", () => {
    const out = injectAttachments("", [attachment], false);
    expect(out).toBe("[Attached files:]\n/data/notes.txt");
  });

  it("no attachments → message passes through unchanged regardless of hasResolvedInvocation", () => {
    expect(injectAttachments("/code-review", [], true)).toBe("/code-review");
  });
});
