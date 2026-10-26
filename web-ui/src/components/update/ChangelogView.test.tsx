import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ChangelogView } from "./ChangelogView";

describe("ChangelogView", () => {
  it("renders sanitized markdown and does not execute script or onerror", () => {
    const malicious = `
# Release Notes

<script>window.__pwned = true;</script>

<img src="x" onerror="window.__pwned = true" />

Hello **world**!
`;
    render(<ChangelogView changelog={malicious} />);

    expect(screen.getByText(/Hello/)).toBeInTheDocument();
    expect(screen.getByText("world")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("drops javascript: links from markdown", () => {
    const md = `[Click me](javascript:alert(1))`;
    render(<ChangelogView changelog={md} />);

    const link = screen.queryByRole("link", { name: "Click me" });
    expect(link).toBeNull();
    expect(screen.getByText("Click me")).toBeInTheDocument();
  });

  it("external link has rel='noopener noreferrer' and target='_blank'", () => {
    const md = `[Docs](https://example.com/docs)`;
    render(<ChangelogView changelog={md} />);

    const link = screen.getByRole("link", { name: "Docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders compare link when behindCount > 1 and releaseUrl provided", () => {
    render(
      <ChangelogView
        changelog="Notes"
        behindCount={3}
        currentVersion="1.0.0"
        latestVersion="1.3.0"
        releaseUrl="https://github.com/fastestdevalive/vibe-station/releases/tag/v1.3.0"
      />,
    );

    const compareLink = screen.getByRole("link", {
      name: "3 releases since v1.0.0 — view all changes ↗",
    });
    expect(compareLink).toHaveAttribute(
      "href",
      "https://github.com/fastestdevalive/vibe-station/compare/v1.0.0...v1.3.0",
    );
  });

  it("compare link ends at the latest tag, never HEAD", () => {
    render(
      <ChangelogView
        changelog="Notes"
        behindCount={2}
        currentVersion="1.1.0"
        latestVersion="1.3.0"
        releaseUrl="https://github.com/fastestdevalive/vibe-station/releases/tag/v1.3.0"
      />,
    );
    const href = screen.getByRole("link", { name: /2 releases since v1\.1\.0/ }).getAttribute("href")!;
    expect(href.endsWith("/compare/v1.1.0...v1.3.0")).toBe(true);
    expect(href).not.toContain("HEAD");
  });

  it("falls back to the release link when the latest version is unknown", () => {
    render(
      <ChangelogView
        behindCount={2}
        currentVersion="1.1.0"
        releaseUrl="https://github.com/fastestdevalive/vibe-station/releases/tag/v1.3.0"
      />,
    );
    expect(screen.getByRole("link", { name: /2 releases since/ })).toHaveAttribute(
      "href",
      "https://github.com/fastestdevalive/vibe-station/releases/tag/v1.3.0",
    );
  });
});
