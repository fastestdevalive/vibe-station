import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DaemonUnreachable } from "./DaemonUnreachable";

describe("DaemonUnreachable", () => {
  it("3.T4 renders retrying copy and hint with role=status", () => {
    render(<DaemonUnreachable />);
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent("Can't reach vibe-station — retrying…");
    expect(el).toHaveTextContent(/daemon is running and reachable/);
  });
});
