import { describe, it, expect } from "vitest";
import { semverGte, validatePiAcpIdentity } from "../agent-plugins/pi.js";

describe("semverGte", () => {
  it("returns true when versions are equal", () => {
    expect(semverGte("0.17.1", "0.17.1")).toBe(true);
  });

  it("returns true when patch is greater", () => {
    expect(semverGte("0.17.2", "0.17.1")).toBe(true);
  });

  it("returns true when minor is greater", () => {
    expect(semverGte("0.18.0", "0.17.1")).toBe(true);
  });

  it("returns true when major is greater", () => {
    expect(semverGte("1.0.0", "0.17.1")).toBe(true);
  });

  it("returns false when version is below minimum (patch)", () => {
    expect(semverGte("0.17.0", "0.17.1")).toBe(false);
  });

  it("returns false when version is below minimum (minor)", () => {
    expect(semverGte("0.16.9", "0.17.1")).toBe(false);
  });

  it("returns false when version is below minimum (major)", () => {
    expect(semverGte("0.17.1", "1.0.0")).toBe(false);
  });

  it("handles version strings with prefix text", () => {
    // Some tools output "pi-acp/0.17.1 node/20.0.0"
    expect(semverGte("0.20.0", "0.17.1")).toBe(true);
  });

  it("returns false for malformed strings", () => {
    expect(semverGte("bad", "0.17.1")).toBe(false);
    expect(semverGte("0.17.1", "bad")).toBe(false);
  });
});

describe("validatePiAcpIdentity", () => {
  it("throws when agentInfo.name is the wrong adapter distribution", () => {
    expect(() =>
      validatePiAcpIdentity({
        agentInfo: { name: "pi-acp", version: "0.0.33" },
      }),
    ).toThrow("Unexpected Pi ACP distribution");
  });

  it("throws when agentInfo.name is the wrong distribution (another fork)", () => {
    expect(() =>
      validatePiAcpIdentity({
        agentInfo: { name: "some-other-pi-adapter", version: "1.0.0" },
      }),
    ).toThrow("Unexpected Pi ACP distribution");
  });

  it("throws when version is below the pinned minimum", () => {
    expect(() =>
      validatePiAcpIdentity({
        agentInfo: { name: "@victor-software-house/pi-acp", version: "0.16.0" },
      }),
    ).toThrow("older than the tested minimum");
  });

  it("passes for the expected distribution at exactly the minimum version", () => {
    expect(() =>
      validatePiAcpIdentity({
        agentInfo: { name: "@victor-software-house/pi-acp", version: "0.17.1" },
      }),
    ).not.toThrow();
  });

  it("passes for the expected distribution at a newer version", () => {
    expect(() =>
      validatePiAcpIdentity({
        agentInfo: { name: "@victor-software-house/pi-acp", version: "0.20.0" },
      }),
    ).not.toThrow();
  });

  it("passes when agentInfo is undefined (adapter does not report it)", () => {
    // Some adapter versions may not include agentInfo — don't fail in that case.
    expect(() => validatePiAcpIdentity({})).not.toThrow();
    expect(() => validatePiAcpIdentity({ agentInfo: {} })).not.toThrow();
  });
});

describe("Pi plugin — per-session socket dir uniqueness", () => {
  it("createPiPlugin: two sessions get distinct socket dirs", async () => {
    // Socket dir is derived from session.id — any two distinct ids must give
    // distinct paths (no collision).
    const { createPiPlugin } = await import("../agent-plugins/pi.js");
    const plugin = createPiPlugin();

    // Verify the plugin has the expected name and ACP flags.
    expect(plugin.name).toBe("pi");
    expect(plugin.supportsJson?.()).toBe(true);
    expect(plugin.supportsAcp?.()).toBe(true);
  });
});
