import { render, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { CodeView } from "@/components/preview/CodeView";

describe("CodeView", () => {
  it("renders token spans from shiki (theme-aware HTML)", async () => {
    const { container } = render(
      <CodeView code={'const x = 1\n'} language="typescript" themeMode="dark" />,
    );
    await waitFor(() => {
      expect(container.querySelector("pre")?.innerHTML.length).toBeGreaterThan(20);
    });
    expect(container.querySelector(".shiki span, .shiki code, [class*=\"shiki\"]")).toBeTruthy();
  });
});
