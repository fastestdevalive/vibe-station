import { describe, it, expect } from "vitest";
import { resolveChannel, sessionChannel, normalizeChannel } from "../services/channel.js";

describe("channel resolution (1.T1)", () => {
  it("sessionChannel({useTmux:false}) → 'pty'", () => {
    expect(sessionChannel({ useTmux: false })).toBe("pty");
  });

  it("sessionChannel({channel:'json'}) → 'json'", () => {
    expect(sessionChannel({ channel: "json" })).toBe("json");
  });

  it("legacy {useTmux:true} → 'tmux'", () => {
    expect(sessionChannel({ useTmux: true })).toBe("tmux");
  });

  it("legacy session with no channel + undefined useTmux → 'tmux' (back-compat)", () => {
    expect(sessionChannel({})).toBe("tmux");
  });

  it("normalizeChannel coerces useTmux=false when channel is json", () => {
    const s = { channel: "json" as const, useTmux: true };
    normalizeChannel(s);
    expect(s.channel).toBe("json");
    expect(s.useTmux).toBe(false);
  });

  it("normalizeChannel stamps a concrete channel on a legacy record", () => {
    const s: { channel?: "tmux" | "pty" | "json"; useTmux?: boolean } = { useTmux: false };
    normalizeChannel(s);
    expect(s.channel).toBe("pty");
  });

  it("resolveChannel: json wins; else tmux/pty split", () => {
    expect(resolveChannel(true, true)).toBe("json");
    expect(resolveChannel(false, true)).toBe("json");
    expect(resolveChannel(true)).toBe("tmux");
    expect(resolveChannel(false)).toBe("pty");
  });
});
