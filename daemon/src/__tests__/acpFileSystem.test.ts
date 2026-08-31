import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextFile, writeTextFile } from "../services/acp/acpFileSystem.js";

describe("acpFileSystem (1.T5)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "acp-fs-test-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("reads a file inside the session cwd by relative path", async () => {
    await writeFile(join(cwd, "hello.txt"), "hello world", "utf8");
    const { content } = await readTextFile(cwd, { path: "hello.txt" });
    expect(content).toBe("hello world");
  });

  it("writes a file inside the session cwd", async () => {
    await writeTextFile(cwd, { path: "out.txt", content: "written" });
    const { content } = await readTextFile(cwd, { path: "out.txt" });
    expect(content).toBe("written");
  });

  it("throws (not a JSON-RPC response) for a missing path — the transport layer wraps this into an error response", async () => {
    await expect(readTextFile(cwd, { path: "does-not-exist.txt" })).rejects.toThrow();
  });

  it("respects line/limit slicing", async () => {
    await writeFile(join(cwd, "multi.txt"), "l1\nl2\nl3\nl4\n", "utf8");
    const { content } = await readTextFile(cwd, { path: "multi.txt", line: 2, limit: 2 });
    expect(content.split("\n")).toEqual(["l2", "l3"]);
  });
});
