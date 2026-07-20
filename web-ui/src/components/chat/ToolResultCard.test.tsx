import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToolResultCard, looksLikeUnifiedDiff } from "./ToolResultCard";

const UNIFIED_DIFF = `diff --git a/app.ts b/app.ts
--- a/app.ts
+++ b/app.ts
@@ -1,3 +1,3 @@
 context line
-const a = 1
+const a = 2
`;

describe("looksLikeUnifiedDiff", () => {
  it("detects unified diffs and rejects plain text", () => {
    expect(looksLikeUnifiedDiff(UNIFIED_DIFF)).toBe(true);
    expect(looksLikeUnifiedDiff("just some tool output\n")).toBe(false);
    expect(looksLikeUnifiedDiff("")).toBe(false);
  });
});

describe("ToolResultCard diff rendering (4.T4)", () => {
  it("renders add/remove line styling for a unified-diff result", async () => {
    const user = userEvent.setup();
    const { container } = render(<ToolResultCard toolName="Edit" content={UNIFIED_DIFF} />);
    // Collapsed by default — expand it.
    await user.click(screen.getByRole("button"));
    expect(container.querySelector(".diff-line--added")).toBeTruthy();
    expect(container.querySelector(".diff-line--removed")).toBeTruthy();
  });

  it("renders non-diff output as monospace text with error styling", async () => {
    const user = userEvent.setup();
    const { container } = render(<ToolResultCard toolName="Bash" content="boom" isError />);
    await user.click(screen.getByRole("button"));
    expect(container.querySelector(".chat-tool-card--error")).toBeTruthy();
    expect(container.querySelector(".diff-line--added")).toBeNull();
    expect(container.textContent).toContain("boom");
  });
});
