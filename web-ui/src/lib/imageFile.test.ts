import { describe, expect, it } from "vitest";
import { isImagePath, resolveImagePath } from "./imageFile";

describe("isImagePath", () => {
  it("returns true for known image extensions (case-insensitive)", () => {
    for (const p of ["a.png", "a.JPG", "b.jpeg", "c.gif", "d.webp", "e.svg", "f.bmp", "g.avif"]) {
      expect(isImagePath(p)).toBe(true);
    }
  });

  it("returns false for non-image extensions", () => {
    for (const p of ["a.txt", "a.md", "a.ts", "noext", "a", "a.tar.gz"]) {
      expect(isImagePath(p)).toBe(false);
    }
  });
});

describe("resolveImagePath", () => {
  it("root-relative strips the leading slash", () => {
    expect(resolveImagePath("/images/foo.png", "docs")).toBe("images/foo.png");
  });

  it("relative joins against baseDir", () => {
    expect(resolveImagePath("./foo.png", "docs")).toBe("docs/foo.png");
    expect(resolveImagePath("./sub/foo.png", "docs")).toBe("docs/sub/foo.png");
    expect(resolveImagePath("./sub/dir/foo.png", "docs")).toBe("docs/sub/dir/foo.png");
  });

  it("relative with no baseDir passes through as-is", () => {
    expect(resolveImagePath("foo.png", null)).toBe("foo.png");
  });

  it("explicit ./ relative with no baseDir strips the ./ (chat failure path)", () => {
    expect(resolveImagePath("./foo.png", null)).toBe("foo.png");
    expect(resolveImagePath("./assets/logo.png", null)).toBe("assets/logo.png");
  });

  it("collapses ../ against baseDir instead of emitting a literal 'docs/../' path", () => {
    expect(resolveImagePath("../assets/ci-pipeline.png", "docs")).toBe("assets/ci-pipeline.png");
    expect(resolveImagePath("../../img.png", "a/b/c")).toBe("a/img.png");
    expect(resolveImagePath("./sub/../foo.png", "docs")).toBe("docs/foo.png");
  });

  it("never climbs above the context root", () => {
    expect(resolveImagePath("../../../x.png", "docs")).toBe("x.png");
    expect(resolveImagePath("../x.png", null)).toBe("x.png");
    expect(resolveImagePath("/../x.png", "docs")).toBe("x.png");
  });
});
