import { describe, expect, it } from "vitest";
import {
  acceptedPath,
  chooserSeed,
  ghostClipped,
  ghostFor,
  isRoot,
  sameFolder,
  parentPath,
  stripSlash,
  visibleEntries,
  withSlash,
  type FolderEntry,
} from "./folderChooserModel";

const e = (name: string): FolderEntry => ({ name, path: `/x/${name}` });

describe("folderChooserModel", () => {
  it("sameFolder_compares_text_up_to_the_last_slash", () => {
    expect(sameFolder("~/code/f", "~/code/fa")).toBe(true);
    expect(sameFolder("~/code/f", "~/f")).toBe(false);
    expect(sameFolder("/a/", "/a/b")).toBe(true);
  });

  it("withSlash_stripSlash_roundtrip", () => {
    expect(withSlash("/a")).toBe("/a/");
    expect(withSlash("/a/")).toBe("/a/");
    expect(withSlash("/")).toBe("/");
    expect(stripSlash("/a/")).toBe("/a");
    expect(stripSlash("/")).toBe("/");
    expect(stripSlash(withSlash("~/code"))).toBe("~/code");
    expect(stripSlash(withSlash("/"))).toBe("/");
  });

  it("visibleEntries_hides_dot_unless_typed", () => {
    const raw = [e("code"), e(".cache")];
    expect(visibleEntries(raw, "~/code/").map((x) => x.name)).toEqual(["code"]);
    expect(visibleEntries(raw, "~/code/.").map((x) => x.name)).toEqual(["code", ".cache"]);
  });

  it("ghostFor_prefix_case_insensitive", () => {
    const raw = [e("fastestdevalive"), e("other")];
    expect(ghostFor("~/code/faste", raw)).toEqual({ remainder: "stdevalive/", entry: e("fastestdevalive") });
    expect(ghostFor("~/code/FASTE", raw)?.remainder).toBe("stdevalive/");
  });

  it("ghostFor_directory_completion_ends_with_slash", () => {
    expect(ghostFor("~/co", [e("code")])?.remainder).toBe("de/");
  });

  it("ghostFor_none_for_empty_segment_or_exact_match", () => {
    const raw = [e("code")];
    expect(ghostFor("~/", raw)).toBeNull();
    expect(ghostFor("~/code/", raw)).toBeNull();
    expect(ghostFor("~/code", raw)).toBeNull();
    expect(ghostFor("~/Code", raw)).toBeNull();
    expect(ghostFor("~/zzz", raw)).toBeNull();
  });

  it("acceptedPath_keeps_tilde_and_fixes_case", () => {
    expect(acceptedPath("~/code/faste", e("fastestdevalive"))).toBe("~/code/fastestdevalive/");
    expect(acceptedPath("~/code/FASTE", e("fastestdevalive"))).toBe("~/code/fastestdevalive/");
    expect(acceptedPath("~/code/", e("other"))).toBe("~/code/other/");
    expect(acceptedPath("~", e("code"))).toBe("~/code/");
    expect(acceptedPath("/home/user/", e("projects"))).toBe("/home/user/projects/");
  });

  it("parentPath_keeps_tilde", () => {
    expect(parentPath("~/a/b/")).toBe("~/a/");
    expect(parentPath("~/a/b")).toBe("~/a/");
    expect(parentPath("~/a/")).toBe("~/");
    expect(parentPath("~/")).toBe("~/");
    expect(parentPath("~")).toBe("~/");
    expect(parentPath("/a/")).toBe("/");
    expect(parentPath("/")).toBe("/");
  });

  it("isRoot_cases", () => {
    expect(isRoot("/")).toBe(true);
    expect(isRoot("~")).toBe(true);
    expect(isRoot("~/")).toBe(true);
    expect(isRoot("/a/")).toBe(false);
    expect(isRoot("~/a")).toBe(false);
  });
});

describe("ghostClipped / chooserSeed", () => {
  it("ghostClipped_is_true_only_when_the_remainder_overflows_a_measurable_box", () => {
    expect(ghostClipped(300, 0, 200)).toBe(true);
    expect(ghostClipped(180, 0, 200)).toBe(false);
    expect(ghostClipped(500, 320, 200)).toBe(false);
    expect(ghostClipped(500, 0, 0)).toBe(false);
  });

  it("chooserSeed_opens_on_a_real_folder", () => {
    expect(chooserSeed("/home/vst/.cl", false)).toBe("/home/vst/");
    expect(chooserSeed("/home/vst/.claude-work", true)).toBe("/home/vst/.claude-work/");
    expect(chooserSeed("~", false)).toBe("~/");
    expect(chooserSeed("foo", false)).toBe("~/");
    expect(chooserSeed("", false)).toBe("~/");
    expect(chooserSeed("   ", false)).toBe("~/");
    expect(chooserSeed("  /a/b  ", true)).toBe("/a/b/");
  });
});
