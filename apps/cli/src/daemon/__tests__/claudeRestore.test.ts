import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the homedir to use a test directory
let testHomeDir: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => testHomeDir || actual.homedir(),
  };
});

describe("claudeRestore — findLatestChatUuid", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-restore-test-"));
    testHomeDir = tempDir;
  });

  afterEach(async () => {
    testHomeDir = "";
    await rm(tempDir, { recursive: true, force: true });
  });

  it("3.T1 — returns null when ~/.claude/projects/<slug>/ does not exist", async () => {
    const { findLatestChatUuid } = await import("../plugins/claudeRestore.js");

    // No .claude/projects dir created — should return null gracefully
    const uuid = await findLatestChatUuid("/some/nonexistent/worktree");
    expect(uuid).toBeNull();
  });

  it("3.T2 — with two jsonl files, returns the uuid of the newest by mtime", async () => {
    const { findLatestChatUuid } = await import("../plugins/claudeRestore.js");

    // Create .claude/projects/<slug>/ with two jsonl files
    const slug = "-test-path-to-worktree";
    const projectsDir = join(tempDir, ".claude", "projects", slug);
    await mkdir(projectsDir, { recursive: true });

    // Create two jsonl files with different mtimes
    const oldFile = join(projectsDir, "old-uuid.jsonl");
    const newFile = join(projectsDir, "new-uuid.jsonl");

    await writeFile(oldFile, "old content");
    // Wait a bit to ensure different mtime
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(newFile, "new content");

    // The uuid should be the newer one
    const uuid = await findLatestChatUuid("/test/path/to/worktree");
    expect(uuid).toBe("new-uuid");
  });

  it("3.T3 — with only one jsonl file, returns its uuid", async () => {
    const { findLatestChatUuid } = await import("../plugins/claudeRestore.js");

    const slug = "-single-file-test";
    const projectsDir = join(tempDir, ".claude", "projects", slug);
    await mkdir(projectsDir, { recursive: true });

    const chatFile = join(projectsDir, "chat-uuid-12345.jsonl");
    await writeFile(chatFile, "chat content");

    const uuid = await findLatestChatUuid("/single/file/test");
    expect(uuid).toBe("chat-uuid-12345");
  });

  it("3.T5 — slug strips dots (e.g. /home/gb/.vibe-station/foo → -home-gb--vibe-station-foo)", async () => {
    const { findLatestChatUuid } = await import("../plugins/claudeRestore.js");

    // Worktree path with a dot dir mid-path (matches real ~/.vibe-station layout)
    const slug = "-home-gb--vibe-station-projects-console-home-worktrees-ch-2";
    const projectsDir = join(tempDir, ".claude", "projects", slug);
    await mkdir(projectsDir, { recursive: true });
    await writeFile(join(projectsDir, "abc-123.jsonl"), "chat");

    const uuid = await findLatestChatUuid(
      "/home/gb/.vibe-station/projects/console-home/worktrees/ch-2",
    );
    expect(uuid).toBe("abc-123");
  });

  it("3.T4 — ignores non-jsonl files and directories", async () => {
    const { findLatestChatUuid } = await import("../plugins/claudeRestore.js");

    const slug = "-mixed-files-test";
    const projectsDir = join(tempDir, ".claude", "projects", slug);
    await mkdir(projectsDir, { recursive: true });

    // Create a jsonl file and some other files
    const jsonlFile = join(projectsDir, "valid-uuid.jsonl");
    const txtFile = join(projectsDir, "readme.txt");
    const subDir = join(projectsDir, "subdir");

    await writeFile(jsonlFile, "chat");
    await writeFile(txtFile, "not a chat");
    await mkdir(subDir);

    const uuid = await findLatestChatUuid("/mixed/files/test");
    expect(uuid).toBe("valid-uuid");
  });
});
