import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveTunnelPort } from "../services/tunnelPort.js";

describe("resolveTunnelPort", () => {
  const original = process.env.VST_TUNNEL_PORT;

  beforeEach(() => {
    delete process.env.VST_TUNNEL_PORT;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.VST_TUNNEL_PORT;
    else process.env.VST_TUNNEL_PORT = original;
  });

  it("2.T8 — falls back to the passed port when VST_TUNNEL_PORT is unset", () => {
    expect(resolveTunnelPort(7421)).toBe(7421);
  });

  it("2.T8 — respects VST_TUNNEL_PORT when set", () => {
    process.env.VST_TUNNEL_PORT = "5173";
    expect(resolveTunnelPort(7421)).toBe(5173);
  });
});
