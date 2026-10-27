import { describe, expect, it } from "vitest";
import { cleanLine, cleanedText, MAX_LINE_CHARS } from "./outputClean";

describe("outputClean", () => {
  it("strips ANSI CSI/SGR and OSC sequences", () => {
    expect(cleanLine("\u001b[31mred\u001b[0m \u001b[1;32mbold\u001b[0m\u001b[2K")).toBe("red bold");
    expect(cleanLine("\u001b]0;title\u0007text")).toBe("text");
  });

  it("keeps only the last \\r segment (progress bars), ignoring a trailing \\r", () => {
    expect(cleanLine("10%\r50%\r100%")).toBe("100%");
    expect(cleanLine("done\r")).toBe("done");
  });

  it("caps a line at 2000 chars with an ellipsis", () => {
    const out = cleanLine("x".repeat(MAX_LINE_CHARS + 50));
    expect(out.length).toBe(MAX_LINE_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("passes lossy replacement characters through", () => {
    expect(cleanLine("bad � byte")).toBe("bad � byte");
  });

  it("Copy text is exactly the cleaned lines", () => {
    expect(cleanedText(["\u001b[31ma\u001b[0m", "b\rc"])).toBe("a\nc");
  });
});
