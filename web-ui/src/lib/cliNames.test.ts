import { describe, expect, it } from "vitest";
import { cliDisplayName } from "./cliNames";

describe("cliDisplayName", () => {
  it("names every harness", () => {
    expect(
      ["claude", "cursor", "opencode", "agy", "codex", "pi", "omp"].map(cliDisplayName),
    ).toEqual(["Claude", "Cursor", "OpenCode", "Antigravity", "Codex", "Pi", "oh-my-pi"]);
  });
  it("passes unknown ids through", () => {
    expect(cliDisplayName("mystery")).toBe("mystery");
  });
});
