import { describe, expect, it } from "vitest";
import { toolActivityLabel } from "./toolActivityLabel";

const t = (name: string, detail?: string | null) => toolActivityLabel({ name, detail })?.text;

describe("toolActivityLabel", () => {
  it("edit-family tools show the file", () => {
    expect(t("Edit", "parseConfig.ts")).toBe("Editing parseConfig.ts");
    expect(t("MultiEdit", "a.ts")).toBe("Editing a.ts");
    expect(t("NotebookEdit", "nb.ipynb")).toBe("Editing nb.ipynb");
    expect(t("Write", "out.json")).toBe("Writing out.json");
    expect(t("Edit")).toBe("Editing files");
  });

  it("read and bash", () => {
    expect(t("Read", "README.md")).toBe("Reading README.md");
    expect(t("Read")).toBe("Reading files");
    expect(t("Bash", "cd")).toBe("Running cd");
    expect(t("Bash")).toBe("Running a command");
  });

  it("search, browse, subagent, planning", () => {
    expect(t("Grep", "never shown")).toBe("Searching");
    expect(t("Glob")).toBe("Searching");
    expect(t("WebFetch")).toBe("Browsing");
    expect(t("WebSearch")).toBe("Browsing");
    expect(t("Task")).toBe("Running a subagent");
    expect(t("TodoWrite")).toBe("Planning");
    expect(t("ExitPlanMode")).toBe("Planning");
  });

  it("mcp tools show the server", () => {
    expect(t("mcp__github__create_issue", "github")).toBe("Calling mcp · github");
    expect(t("mcp__linear__list")).toBe("Calling mcp · linear");
  });

  it("unknown tools fall back to Using <name>", () => {
    expect(t("FrobnicateTool")).toBe("Using FrobnicateTool");
  });

  it("returns null without a tool", () => {
    expect(toolActivityLabel(null)).toBeNull();
    expect(toolActivityLabel(undefined)).toBeNull();
    expect(toolActivityLabel({ name: "  " })).toBeNull();
  });

  it("categorises for the glyph", () => {
    expect(toolActivityLabel({ name: "Bash" })?.kind).toBe("run");
    expect(toolActivityLabel({ name: "mcp__a__b" })?.kind).toBe("mcp");
    expect(toolActivityLabel({ name: "x" })?.kind).toBe("other");
  });

  it("past tense reads as done (Needs-you cards)", () => {
    const p = (name: string, detail?: string | null) =>
      toolActivityLabel({ name, detail }, "past")?.text;
    expect(p("Edit", "a.ts")).toBe("Edited a.ts");
    expect(p("Edit")).toBe("Edited files");
    expect(p("Write", "out.json")).toBe("Wrote out.json");
    expect(p("Read", "README.md")).toBe("Read README.md");
    expect(p("Read")).toBe("Read files");
    expect(p("Bash", "cd")).toBe("Ran cd");
    expect(p("Bash")).toBe("Ran a command");
    expect(p("Grep")).toBe("Searched");
    expect(p("WebFetch")).toBe("Browsed");
    expect(p("Task")).toBe("Ran a subagent");
    expect(p("TodoWrite")).toBe("Planned");
    expect(p("Frobnicate")).toBe("Used Frobnicate");
    expect(p("mcp__github__list", "github")).toBe("Called mcp · github");
    expect(toolActivityLabel({ name: "Edit", detail: "a.ts" }, "past")?.verb).toBe("Edited");
  });
});
