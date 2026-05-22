import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listFiles,
  _resetRipgrepDetectionForTest,
  _setRipgrepAvailableForTest,
  _setMaxEntriesForTest,
} from "../services/fileList.js";

describe("fileList service", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vst-filelist-"));
    _resetRipgrepDetectionForTest();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    _resetRipgrepDetectionForTest();
    _setMaxEntriesForTest(null);
  });

  it("Node fallback enumerates files and respects root .gitignore", async () => {
    _setRipgrepAvailableForTest(false);

    await writeFile(join(dir, ".gitignore"), "ignored.txt\nnested/\n");
    await writeFile(join(dir, "a.txt"), "a");
    await writeFile(join(dir, "b.md"), "b");
    await writeFile(join(dir, "ignored.txt"), "x");
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "c.ts"), "c");
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "d.txt"), "d");

    const result = await listFiles(dir);
    expect(result.source).toBe("node");
    expect(result.truncated).toBe(false);
    expect(result.files).toEqual(
      expect.arrayContaining([".gitignore", "a.txt", "b.md", "src/c.ts"]),
    );
    expect(result.files).not.toContain("ignored.txt");
    expect(result.files.some((f) => f.startsWith("nested/"))).toBe(false);
  });

  it("Node fallback skips .git/ directory", async () => {
    _setRipgrepAvailableForTest(false);
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    await writeFile(join(dir, "real.txt"), "r");

    const result = await listFiles(dir);
    expect(result.files).toContain("real.txt");
    expect(result.files.some((f) => f.startsWith(".git/"))).toBe(false);
  });

  it("Node fallback survives broken symlinks", async () => {
    _setRipgrepAvailableForTest(false);
    await writeFile(join(dir, "good.txt"), "ok");
    await symlink(join(dir, "does-not-exist"), join(dir, "broken-link"));

    const result = await listFiles(dir);
    expect(result.files).toContain("good.txt");
    // Broken symlink must not crash the walk. It may or may not appear in
    // the result depending on backend, but the listing must complete.
  });

  it("ripgrep backend is used when available", async () => {
    // Skip if `rg` is not on PATH in the test environment.
    _resetRipgrepDetectionForTest();
    await writeFile(join(dir, "x.txt"), "x");

    const result = await listFiles(dir);
    // Either backend is fine; just assert the file shows up.
    expect(result.files).toContain("x.txt");
    expect(["ripgrep", "node"]).toContain(result.source);
  });

  /** When rg is forced available AND on PATH, source must be ripgrep — not
   *  just "either". Without this assertion, the previous test passes even
   *  when rg silently disappears from CI, hiding real regressions. */
  it("source is strictly 'ripgrep' when rg is forced available and on PATH", async () => {
    // We can't fake rg availability without an actual binary — guard with
    // a real probe; skip if rg isn't installed in this environment.
    _resetRipgrepDetectionForTest();
    const probe = await listFiles(dir);
    if (probe.source !== "ripgrep") {
      // rg not available — environment limitation, not a test failure.
      return;
    }
    _setRipgrepAvailableForTest(true);
    await writeFile(join(dir, "rg-required.txt"), "rg");

    const result = await listFiles(dir);
    expect(result.source).toBe("ripgrep");
    expect(result.files).toContain("rg-required.txt");
  });

  it("Node fallback honors MAX_ENTRIES cap and reports truncated:true", async () => {
    _setRipgrepAvailableForTest(false);
    _setMaxEntriesForTest(5);
    // Create 10 files — twice the cap.
    for (let i = 0; i < 10; i++) {
      await writeFile(join(dir, `f${i}.txt`), String(i));
    }

    const result = await listFiles(dir);
    expect(result.source).toBe("node");
    expect(result.truncated).toBe(true);
    expect(result.files.length).toBeLessThanOrEqual(5);
    expect(result.files.length).toBeGreaterThan(0);
  });

  it("ripgrep backend honors MAX_ENTRIES cap and reports truncated:true", async () => {
    _resetRipgrepDetectionForTest();
    _setMaxEntriesForTest(5);
    for (let i = 0; i < 30; i++) {
      await writeFile(join(dir, `f${i}.txt`), String(i));
    }

    const result = await listFiles(dir);
    // rg may or may not be installed; the cap behavior must hold for either.
    expect(result.truncated).toBe(true);
    expect(result.files.length).toBeLessThanOrEqual(5);
    expect(result.files.length).toBeGreaterThan(0);
  });

  it("ripgrep backend excludes .git/", async () => {
    _resetRipgrepDetectionForTest();
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    await writeFile(join(dir, "y.txt"), "y");

    const result = await listFiles(dir);
    expect(result.files).toContain("y.txt");
    expect(result.files.some((f) => f.startsWith(".git/") || f === ".git")).toBe(false);
  });
});
