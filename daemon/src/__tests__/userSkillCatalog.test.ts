import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanSkillDirectory,
  mergeCatalogs,
  setSkillPaths,
  getSkillEntries,
  getSkillDirectories,
  resetSkillCatalogForTests,
} from "../services/userSkillCatalog.js";
import { buildServer } from "../server.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vst-skill-catalog-test-"));
});

afterEach(async () => {
  resetSkillCatalogForTests();
  await rm(tempDir, { recursive: true, force: true });
});

async function writeSkill(dir: string, name: string, frontmatter: string): Promise<void> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), frontmatter, "utf8");
}

describe("4.T1 — scanSkillDirectory", () => {
  it("a directory with two <name>/SKILL.md files yields two entries", async () => {
    await writeSkill(
      tempDir,
      "code-review",
      "---\nname: code-review\ndescription: Review code for bugs\nargumentHint: [severity]\n---\nBody\n",
    );
    await writeSkill(
      tempDir,
      "security-review",
      "---\nname: security-review\ndescription: Audit for security issues\n---\nBody\n",
    );

    const { entries, status } = await scanSkillDirectory(tempDir);

    expect(entries).toHaveLength(2);
    expect(status.skillCount).toBe(2);
    expect(status.error).toBeUndefined();
    const codeReview = entries.find((e) => e.name === "code-review");
    expect(codeReview).toEqual({
      name: "code-review",
      description: "Review code for bugs",
      argumentHint: "[severity]",
      path: join(tempDir, "code-review", "SKILL.md"),
    });
  });

  it("a malformed SKILL.md (no name in frontmatter) is skipped and reported as a per-directory error, not thrown", async () => {
    await writeSkill(tempDir, "good-skill", "---\nname: good-skill\ndescription: Fine\n---\nBody\n");
    await writeSkill(tempDir, "bad-skill", "---\ndescription: Missing a name\n---\nBody\n");

    const { entries, status } = await scanSkillDirectory(tempDir);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("good-skill");
    expect(status.skillCount).toBe(1);
    expect(status.error).toBeDefined();
    expect(status.error).toContain("bad-skill");
  });

  it("an absent directory is reported as `missing`, not an error (shipped defaults for uninstalled CLIs)", async () => {
    const missing = join(tempDir, "does-not-exist");
    const { entries, status } = await scanSkillDirectory(missing);
    expect(entries).toEqual([]);
    expect(status.skillCount).toBe(0);
    expect(status.missing).toBe(true);
    expect(status.error).toBeUndefined();
  });

  it("a path that exists but is a FILE is a real error, not `missing`", async () => {
    const asFile = join(tempDir, "a-file");
    await writeFile(asFile, "not a directory", "utf8");
    const { entries, status } = await scanSkillDirectory(asFile);
    expect(entries).toEqual([]);
    expect(status.error).toBeDefined();
    expect(status.missing).toBeUndefined();
  });

  it("a subdirectory with no SKILL.md is silently ignored (not an error)", async () => {
    await mkdir(join(tempDir, "not-a-skill"), { recursive: true });
    const { entries, status } = await scanSkillDirectory(tempDir);
    expect(entries).toEqual([]);
    expect(status.error).toBeUndefined();
  });
});

describe("4.T2 — mergeCatalogs (per-field merge, Decision 7)", () => {
  it("an ACP entry and a directory entry with the same name resolve to the ACP entry's description/argumentHint AND the directory entry's path", () => {
    const dirEntries = [
      {
        name: "code-review",
        description: "stale directory description",
        argumentHint: "[stale hint]",
        path: "/home/user/.claude/skills/code-review/SKILL.md",
      },
    ];
    const acpCommands = [
      { name: "code-review", description: "fresh ACP description", argumentHint: "[fresh hint]" },
    ];

    const merged = mergeCatalogs(acpCommands, dirEntries);

    expect(merged).toEqual([
      {
        name: "code-review",
        description: "fresh ACP description",
        argumentHint: "[fresh hint]",
        path: "/home/user/.claude/skills/code-review/SKILL.md",
      },
    ]);
  });

  it("an ACP-only name has path undefined", () => {
    const merged = mergeCatalogs([{ name: "model", description: "Switch model" }], []);
    expect(merged).toEqual([{ name: "model", description: "Switch model", argumentHint: undefined, path: undefined }]);
  });

  it("M4 — an ACP entry that OMITS description/argumentHint does not clobber the directory entry's real values", () => {
    const dirEntries = [
      {
        name: "code-review",
        description: "real directory description",
        argumentHint: "[real hint]",
        path: "/home/user/.claude/skills/code-review/SKILL.md",
      },
    ];
    // claude's ACP catalog enumerates the SAME skills the scanner reads — a
    // collision with an empty description and no argumentHint is the NORMAL
    // case, not a rare edge (name collision on every user skill).
    const acpCommands = [{ name: "code-review", description: "" }];

    const merged = mergeCatalogs(acpCommands, dirEntries);

    expect(merged).toEqual([
      {
        name: "code-review",
        description: "real directory description",
        argumentHint: "[real hint]",
        path: "/home/user/.claude/skills/code-review/SKILL.md",
      },
    ]);
  });

  it("M4 — an ACP entry whose description/argumentHint are present but EMPTY does not clobber either", () => {
    const dirEntries = [
      {
        name: "code-review",
        description: "real directory description",
        argumentHint: "[real hint]",
        path: "/home/user/.claude/skills/code-review/SKILL.md",
      },
    ];
    // `normalize.ts` surfaces ACP's `input.hint` verbatim, so an adapter that
    // publishes an empty hint string reaches the merge as `argumentHint: ""` —
    // an empty ACP value must fall through to the directory entry exactly like
    // an absent one (this is why the merge uses `||`, not `??`).
    const acpCommands = [{ name: "code-review", description: "", argumentHint: "" }];

    const merged = mergeCatalogs(acpCommands, dirEntries);

    expect(merged).toEqual([
      {
        name: "code-review",
        description: "real directory description",
        argumentHint: "[real hint]",
        path: "/home/user/.claude/skills/code-review/SKILL.md",
      },
    ]);
  });

  it("a directory-only name keeps its own description/argumentHint/path", () => {
    const dirEntries = [{ name: "local-only", description: "Local skill", path: "/skills/local-only/SKILL.md" }];
    const merged = mergeCatalogs(undefined, dirEntries);
    expect(merged).toEqual([
      { name: "local-only", description: "Local skill", argumentHint: undefined, path: "/skills/local-only/SKILL.md" },
    ]);
  });
});

describe("4.T3a — setSkillPaths chokidar watch + debounce lands new entries", () => {
  it("a file added to a watched directory lands in getSkillEntries() within one debounce window", async () => {
    vi.useRealTimers();
    await setSkillPaths([tempDir]);
    expect(getSkillEntries()).toEqual([]);

    await writeSkill(tempDir, "new-skill", "---\nname: new-skill\ndescription: Added after watch start\n---\n");

    // Debounce window is 200ms — poll up to 2s for the rescan to land.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (getSkillEntries().some((e) => e.name === "new-skill")) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(getSkillEntries().map((e) => e.name)).toContain("new-skill");
  }, 10000);
});

describe("carry-over fix — buildServer() alone starts no skill watcher", () => {
  it("does not call setSkillPaths / start a chokidar watch as a side effect of building the server", async () => {
    resetSkillCatalogForTests();
    const app = await buildServer({ port: 0, logger: false, token: "test-token", noAuth: true });
    try {
      // buildServer() must never itself initialize the skill catalog — that
      // happens only in daemon/src/main.ts (the real entry point, which
      // tests never call), specifically to avoid leaking a chokidar watcher
      // into every one of the ~90 daemon test files that call buildServer().
      expect(getSkillEntries()).toEqual([]);
      expect(getSkillDirectories()).toEqual([]);
    } finally {
      await app.close();
      resetSkillCatalogForTests();
    }
  });
});

describe("absent skill directory (shipped defaults for uninstalled CLIs)", () => {
  it("reports a non-existent directory as `missing`, NOT as an error", async () => {
    const absent = join(tmpdir(), `vst-absent-${Date.now()}`);
    await setSkillPaths([absent]);
    const dir = getSkillDirectories().find((d) => d.path === absent);
    expect(dir).toBeDefined();
    expect(dir?.missing).toBe(true);
    expect(dir?.error).toBeUndefined();
    expect(dir?.skillCount).toBe(0);
  });
});
