import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgram } from "../program";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "..", "package.json");
const expectedVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version as string;

describe("vst CLI program", () => {
  it("builds without throwing", () => {
    const program = buildProgram();
    expect(program.name()).toBe("vst");
  });

  it("registers --version that matches package.json", () => {
    const program = buildProgram();
    expect(program.version()).toBe(expectedVersion);
  });

  it("--version prints the version to stdout and exits 0", async () => {
    const program = buildProgram();
    program.exitOverride();

    let output = "";
    program.configureOutput({
      writeOut: (s) => {
        output += s;
      },
    });

    try {
      await program.parseAsync(["node", "vst", "--version"]);
    } catch (err) {
      expect((err as { code?: string }).code).toBe("commander.version");
    }
    expect(output.trim()).toBe(expectedVersion);
  });

  it("has a description", () => {
    const program = buildProgram();
    expect(program.description()).toMatch(/vibe-station/);
  });
});
