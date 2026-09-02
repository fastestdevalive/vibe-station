import { describe, expect, it } from "vitest";
import { segmentMarkdownWithMermaid } from "./mdSegments";

describe("segmentMarkdownWithMermaid", () => {
  it("returns a single markdown segment when there are no mermaid blocks", () => {
    const src = "# Hello\n\nJust prose.";
    expect(segmentMarkdownWithMermaid(src)).toEqual([{ type: "markdown", content: src }]);
  });

  it("splits a single mermaid block out of surrounding prose", () => {
    const src = "Before\n\n```mermaid\ngraph TD; A-->B\n```\n\nAfter";
    const segs = segmentMarkdownWithMermaid(src);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ type: "markdown", content: "Before\n\n" });
    expect(segs[1]).toEqual({ type: "mermaid", content: "graph TD; A-->B" });
    expect(segs[2]).toEqual({ type: "markdown", content: "\n\nAfter" });
  });

  it("handles multiple mermaid blocks in one document", () => {
    const src = "A\n\n```mermaid\ngraph TD; A-->B\n```\n\nB\n\n```mermaid\nflowchart LR; X-->Y\n```\n\nC";
    const segs = segmentMarkdownWithMermaid(src);
    expect(segs.filter((s) => s.type === "mermaid")).toHaveLength(2);
    expect(segs.filter((s) => s.type === "markdown")).toHaveLength(3);
  });

  it("does not confuse plain code fences with mermaid fences", () => {
    const src = "```ts\nconst x = 1;\n```\n\n```mermaid\ngraph TD; A-->B\n```";
    const segs = segmentMarkdownWithMermaid(src);
    expect(segs.filter((s) => s.type === "mermaid")).toHaveLength(1);
    expect(segs[0]).toEqual({ type: "markdown", content: "```ts\nconst x = 1;\n```\n\n" });
    expect(segs[1]).toEqual({ type: "mermaid", content: "graph TD; A-->B" });
  });

  it("finds a mermaid block in a plan file with YAML frontmatter, HTML comments, and other code blocks", () => {
    // Mirrors the structure of a real plan file (e.g. the storage-management plan
    // from the management-ui-option branch) that originally failed to render because
    // the parse() pre-check was too conservative.
    const src = [
      "---",
      "Issue: N/A",
      "Status: planning",
      "---",
      "",
      "<!--",
      "RULES — no prose",
      "-->",
      "",
      "## Change Map",
      "",
      "```",
      "daemon/src/routes/",
      "  worktrees.ts  ~ add guard",
      "```",
      "",
      "## Architecture Diagram",
      "",
      "```mermaid",
      "flowchart LR",
      '    subgraph Browser',
      '        StorageSetting --> ClientDisk[api.getDiskUsage]',
      '    end',
      '    subgraph Daemon',
      '        DiskRoute["GET /worktrees/disk-usage"]',
      '    end',
      '    ClientDisk --"GET /worktrees/disk-usage"--> DiskRoute',
      '    DeleteRoute --> Guard{agents=done, terminals=done|exited?}',
      '    Guard --"no"--> 409',
      '    Guard --"yes"--> Purge[worktreeRemove]',
      "```",
      "",
      "## Details",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");

    const segs = segmentMarkdownWithMermaid(src);
    const mermaidSegs = segs.filter((s) => s.type === "mermaid");
    expect(mermaidSegs).toHaveLength(1);
    expect(mermaidSegs[0]?.content).toContain("flowchart LR");
    // The special characters that confused the old parse() pre-check are present.
    expect(mermaidSegs[0]?.content).toContain("terminals=done|exited?");
    expect(mermaidSegs[0]?.content).toContain('"GET /worktrees/disk-usage"');
  });

  it("trims whitespace from the mermaid block content", () => {
    const src = "```mermaid\n  graph TD; A-->B  \n```";
    const segs = segmentMarkdownWithMermaid(src);
    expect(segs[0]?.type).toBe("mermaid");
    expect(segs[0]?.content).toBe("graph TD; A-->B");
  });
});
