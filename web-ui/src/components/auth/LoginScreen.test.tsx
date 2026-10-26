import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { LoginScreen } from "./LoginScreen";

describe("LoginScreen", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("shows default pairing copy when no restart occurred", () => {
    render(<LoginScreen onSuccess={() => {}} />);
    expect(screen.getByText(/Open the desktop app/i)).toBeInTheDocument();
    expect(screen.queryByText(/Signed out by restart/i)).toBeNull();
  });

  it("shows 'Signed out by restart — run vst open' when vst:restartedAt is fresh (<2min)", () => {
    sessionStorage.setItem("vst:restartedAt", (Date.now() - 30_000).toString());
    render(<LoginScreen onSuccess={() => {}} />);

    expect(screen.getByText(/Signed out by restart — run/i)).toBeInTheDocument();
    expect(screen.getByText("vst open")).toBeInTheDocument();
    // Key should have been cleared from sessionStorage
    expect(sessionStorage.getItem("vst:restartedAt")).toBeNull();
  });

  it("shows default copy when vst:restartedAt is older than 2min", () => {
    sessionStorage.setItem("vst:restartedAt", (Date.now() - 3 * 60 * 1000).toString());
    render(<LoginScreen onSuccess={() => {}} />);

    expect(screen.getByText(/Open the desktop app/i)).toBeInTheDocument();
    expect(screen.queryByText(/Signed out by restart/i)).toBeNull();
    // Key should still have been removed
    expect(sessionStorage.getItem("vst:restartedAt")).toBeNull();
  });
});
