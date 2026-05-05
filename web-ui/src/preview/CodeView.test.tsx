import { render, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { CodeView } from "@/components/preview/CodeView";

describe("CodeView", () => {
  it("renders token spans from shiki (theme-aware HTML)", async () => {
    const { container } = render(
      <CodeView code={'const x = 1\n'} language="typescript" themeMode="dark" />,
    );
    await waitFor(
      () => {
        expect(
          container.querySelector(".workspace-code-content--shiki span[style*=\"color\"]"),
        ).toBeTruthy();
      },
      { timeout: 15000 },
    );
  });
});
