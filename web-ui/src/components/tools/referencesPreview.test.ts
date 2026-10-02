import { describe, expect, it } from "vitest";
import { matchSpan, previewWindow, splitGroupPath } from "./referencesPreview";

function marked(w: ReturnType<typeof previewWindow>): string {
  return w.text.slice(w.matchStart, w.matchStart + w.matchLength);
}

describe("previewWindow (Bug 2 — raw preview + [character, endCharacter))", () => {
  it("windows long lines around the match with ellipses on both sides", () => {
    const longLine = "a".repeat(50) + "TARGET_SYMBOL" + "b".repeat(80);
    const w = previewWindow(longLine, 50, 63, 0, 30, 60);
    expect(w.text.startsWith("…")).toBe(true);
    expect(w.text.endsWith("…")).toBe(true);
    expect(marked(w)).toBe("TARGET_SYMBOL");
  });

  it("marks the referenced token on an indented raw line (no indent shift)", () => {
    // network_swap.rs:234 — indented 4, the old trimmed-preview bug marked "cribe();".
    const line = "    let mut rx = control.subscribe();";
    const character = line.indexOf("subscribe");
    const w = previewWindow(line, character, character + "subscribe".length, "subscribe".length);
    expect(marked(w)).toBe("subscribe");
    // Leading indentation is not shown and not counted as context.
    expect(w.text.startsWith("let mut")).toBe(true);
  });

  it("uses endCharacter, not the queried symbol length (Self references)", () => {
    const line = "        Self { tx, flag }";
    const character = line.indexOf("Self");
    const w = previewWindow(line, character, character + 4, "NetworkControl".length);
    expect(marked(w)).toBe("Self");
  });

  it("falls back to the symbol length when endCharacter is absent", () => {
    const line = "fn run() {";
    const w = previewWindow(line, 3, null, 3);
    expect(marked(w)).toBe("run");
  });

  it("never windows the symbol out on a long deeply-indented line", () => {
    const line = " ".repeat(40) + "x".repeat(70) + ".set(true)";
    const character = line.indexOf("set");
    const w = previewWindow(line, character, character + 3, 3);
    expect(marked(w)).toBe("set");
  });

  it("marks the occurrence at character, not the first indexOf", () => {
    const line = 'makeGreeter("a"), makeGreeter("b")';
    const second = line.lastIndexOf("makeGreeter");
    const w = previewWindow(line, second, second + 11, 11);
    expect(w.matchStart).toBe(second);
    expect(marked(w)).toBe("makeGreeter");
  });

  it("renders without a mark when character is out of range", () => {
    const w = previewWindow("  run();", 8, null, 3);
    expect(w.matchStart).toBe(-1);
    expect(w.text).toBe("run();");
  });

  it("ignores trailing whitespace when deciding the suffix ellipsis", () => {
    const w = previewWindow("foo();   ", 0, 3, 3);
    expect(w.text).toBe("foo();");
  });
});

describe("matchSpan", () => {
  it("rejects an endCharacter beyond the line", () => {
    expect(matchSpan("abc", 0, 99, 2)).toEqual({ start: 0, end: 2 });
  });
  it("returns null for a negative character", () => {
    expect(matchSpan("abc", -1, 2, 2)).toBeNull();
  });
});

describe("splitGroupPath (2.1)", () => {
  it("puts the file name first and the directory after it", () => {
    expect(splitGroupPath("rust/vst-daemon/src/network.rs", false)).toEqual({
      name: "network.rs",
      dir: "rust/vst-daemon/src",
    });
  });
  it("has no directory for a top-level file", () => {
    expect(splitGroupPath("README.md", false)).toEqual({ name: "README.md", dir: "" });
  });
  it("shortens external registry and home paths", () => {
    expect(
      splitGroupPath("/home/vst/.cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-1.40.0/src/sync/oneshot.rs", true),
    ).toEqual({ name: "oneshot.rs", dir: "registry/tokio-1.40.0/src/sync" });
    expect(splitGroupPath("/home/vst/.rustup/toolchains/x/lib.rs", true).dir).toBe("~/.rustup/toolchains/x");
  });
});
