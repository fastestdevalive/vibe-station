import { describe, it, expect } from "vitest";
import { slugify, isSafeProjectId } from "../services/slugify.js";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("My Cool App")).toBe("my-cool-app");
  });

  it("preserves internal dots", () => {
    expect(slugify("foo.bar")).toBe("foo.bar");
  });

  it("strips leading/trailing dots and hyphens", () => {
    expect(slugify(".env")).toBe("env");
    expect(slugify("app.")).toBe("app");
    expect(slugify("--app--")).toBe("app");
  });

  // Regression: a project id is used to build filesystem paths, so a dot-only
  // name must never survive as an id (".." → ~/.vibe-station, "." → its parent),
  // which previously enabled `DELETE /projects/..` to rm the whole data dir.
  it("never yields a path-traversal token", () => {
    expect(slugify("..")).toBe("project");
    expect(slugify(".")).toBe("project");
    expect(slugify("...")).toBe("project");
    expect(slugify("/")).toBe("project");
    expect(slugify("../../etc")).toBe("etc");
  });

  it("falls back to 'project' for empty/only-special input", () => {
    expect(slugify("")).toBe("project");
    expect(slugify("   ")).toBe("project");
    expect(slugify("@#$%")).toBe("project");
  });
});

describe("isSafeProjectId", () => {
  it("accepts normal ids", () => {
    expect(isSafeProjectId("my-app")).toBe(true);
    expect(isSafeProjectId("foo.bar")).toBe(true);
  });

  it("rejects traversal tokens and separators", () => {
    expect(isSafeProjectId("")).toBe(false);
    expect(isSafeProjectId(".")).toBe(false);
    expect(isSafeProjectId("..")).toBe(false);
    expect(isSafeProjectId("a/b")).toBe(false);
    expect(isSafeProjectId("a\\b")).toBe(false);
  });
});
