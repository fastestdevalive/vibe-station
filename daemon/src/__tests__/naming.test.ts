import { describe, it, expect } from "vitest";
import { slugifyPrompt } from "../services/naming.js";

describe("slugifyPrompt", () => {
  it("3.T1 derives a 2-word slug, dropping stopwords/noise", () => {
    expect(slugifyPrompt("Implement the login flow described in SPEC.md")).toBe("implement-login-flow");
  });

  it("3.T2 strips path-shaped tokens entirely (no leaked path segments)", () => {
    const slug = slugifyPrompt("Review the diff at /tmp/pr.diff and summarise findings.");
    expect(slug).not.toContain("tmp");
    expect(slug).not.toContain("pr");
  });

  it("3.T3 empty/whitespace-only prompt -> \"\"", () => {
    expect(slugifyPrompt("")).toBe("");
    expect(slugifyPrompt("   \n\t  ")).toBe("");
  });

  it("3.T3 non-ASCII-only prompt -> \"\"", () => {
    expect(slugifyPrompt("ログインフローを実装してください")).toBe("");
  });

  it("3.T4 output length never exceeds 60 chars for a long run-on prompt", () => {
    const longPrompt = Array.from({ length: 40 }, (_, i) => `wordnumber${i}`).join(" ");
    const slug = slugifyPrompt(longPrompt, 40, 60);
    expect(slug.length).toBeLessThanOrEqual(60);
  });

  it("caps at maxWords by default", () => {
    const slug = slugifyPrompt("refactor the authentication middleware logging pipeline completely");
    expect(slug.split("-").length).toBeLessThanOrEqual(3);
  });

  it("strips code fences and URLs", () => {
    const slug = slugifyPrompt("```const x = 1;``` fix the bug at https://example.com/issue/123 please");
    expect(slug).not.toContain("const");
    expect(slug).not.toContain("example");
  });

  describe("informativeness (regressions from real production prompts)", () => {
    it("never leaks worktree/PR-shaped id tokens", () => {
      for (const id of ["vs-45", "pr17", "ch-61", "unl46", "vs45"]) {
        const slug = slugifyPrompt(`Fix the flaky migration test in ${id} before release`);
        // Assert against the id verbatim, its hyphen-stripped form AND its
        // alphabetic prefix — `not.toContain(id.replace(/-/g, ""))` alone is
        // vacuous for hyphenated ids, since the slug preserves hyphens.
        expect(slug).not.toContain(id);
        expect(slug).not.toContain(id.replace(/-/g, ""));
        expect(slug.split("-")).not.toContain(id.replace(/[-\d]/g, ""));
      }
    });

    it("real prompt: no longer produces `previous-started-vs-45`", () => {
      const prompt =
        "The previous worktree that was started vs-45, didn't get a good name. Looks like the name " +
        "thing that we introduced is not working correctly. Can you please explore the issue and " +
        "refer to opus subagent to help with a better name genration.\n\nAdditionally, I realized " +
        "that there are many words that still creep into the name which shouldn't have been. If you " +
        "have accesss to the intro prompts for the last 20 sessions, can you try to call the method " +
        "against them and see the output. Create a table and then see if they are acceptable or not.";
      const slug = slugifyPrompt(prompt);
      expect(slug).not.toContain("vs-45");
      expect(slug).not.toContain("previous");
      expect(slug).not.toContain("started");
      expect(slug).toContain("name"); // the actual subject of the prompt
    });

    it("real prompt: `I would like to change the default values...` picks the topic, not the filler", () => {
      const prompt =
        "I would like to change the default values for whenver the edge glow and selector glow are " +
        "enabled\n\nThe edge glow:\nEdges: L+R\nCorner: 24 DP\nThickness: 1dp\n\nAnd gradient should " +
        "be themed. For selector glow:\nAnimation: Moving gradient\nGradient: Same as above\n" +
        "Selector thickness: 2dp";
      const slug = slugifyPrompt(prompt);
      expect(slug).not.toBe("like-change-default");
      expect(slug).toContain("glow");
    });

    it("real prompt: `That worktree has just one commit...` avoids `has-one-commit`", () => {
      const prompt =
        "I am on this worktree: http://100.102.0.25:5173/worktree/ch-54. That worktree has just one " +
        "commit on the branch but the VCS tab in vst is showing many many commits. Why is that? " +
        "Whats going on?";
      const slug = slugifyPrompt(prompt);
      expect(slug).not.toBe("has-one-commit");
      expect(slug).toContain("vcs");
    });

    it("drops filename-shaped tokens rather than leaking their extension", () => {
      const slug = slugifyPrompt("Add the missing preview pane to BackgroundStep.kt for onboarding");
      expect(slug.split("-")).not.toContain("kt");
    });

    it("expands contractions instead of leaving `didn`/`t` fragments", () => {
      const slug = slugifyPrompt("The deploy didn't publish the release manifest, please investigate");
      expect(slug.split("-")).not.toContain("didn");
      expect(slug.split("-")).not.toContain("t");
    });

    it("prefers a repeated topical term over leading filler", () => {
      const slug = slugifyPrompt(
        "I was just thinking that maybe we should take a look at this. The throttling logic is " +
          "wrong: throttling kicks in too early and throttling never resets.",
      );
      expect(slug).toContain("throttling");
    });

    it("keeps 2-letter ALL-CAPS acronyms but not 2-letter ordinary words", () => {
      const slug = slugifyPrompt("Redesign the UI for the onboarding carousel");
      expect(slug.split("-")).toContain("ui");
    });

    it("does not repeat a word already covered by a hyphenated pick", () => {
      const slug = slugifyPrompt(
        "Add moving-backgrounds support: we want customizable backgrounds with animated backgrounds.",
      );
      const parts = slug.split("-");
      expect(new Set(parts).size).toBe(parts.length);
    });

    it("a pure-filler prompt still yields something rather than an empty slug", () => {
      expect(slugifyPrompt("Can you please just have a look at this and see how it goes?")).not.toBe("");
    });

    it("is deterministic", () => {
      const p = "Migrate the workspace persistence layer from localStorage into the daemon sqlite db";
      expect(slugifyPrompt(p)).toBe(slugifyPrompt(p));
    });

    it("a prompt of nothing but core function words (no fallback content at all) -> \"\"", () => {
      // Every survivor of the loose fallback pass would itself be a bare
      // grammatical connector ("the") — that's not better than no name.
      expect(slugifyPrompt("the a an of to")).toBe("");
    });

    it("does not hang or slow down on a very long, whitespace-sparse prompt (quadratic-regex guard)", () => {
      const pathological = "a.b-".repeat(20000); // ~80k chars, no whitespace
      const start = Date.now();
      slugifyPrompt(pathological);
      expect(Date.now() - start).toBeLessThan(500);
    });
  });
});
