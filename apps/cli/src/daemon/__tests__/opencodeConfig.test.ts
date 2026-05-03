import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeOpenCodeConfig } from "../services/opencodeConfig.js";

describe("writeOpenCodeConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vrun-opencode-config-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes valid JSON with the given instruction files", async () => {
    const configPath = join(tempDir, "opencode-config.json");
    const instructionFile = "/absolute/path/to/system-prompt.md";

    writeOpenCodeConfig(configPath, [instructionFile]);

    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({ instructions: [instructionFile] });
  });

  it("stores absolute paths as-is", async () => {
    const configPath = join(tempDir, "opencode-config.json");
    const files = ["/home/user/.viberun/projects/p1/worktrees/wt/sessions/s1/system-prompt.md"];

    writeOpenCodeConfig(configPath, files);

    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.instructions).toHaveLength(1);
    expect(parsed.instructions[0]).toBe(files[0]);
  });

  it("supports multiple instruction files", async () => {
    const configPath = join(tempDir, "opencode-config.json");
    const files = ["/path/a.md", "/path/b.md"];

    writeOpenCodeConfig(configPath, files);

    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.instructions).toEqual(files);
  });

  it("returns the config path", () => {
    const configPath = join(tempDir, "opencode-config.json");
    const result = writeOpenCodeConfig(configPath, ["/some/file.md"]);
    expect(result).toBe(configPath);
  });
});
