import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TruncatedBanner } from "./ArtifactStatePanels";

describe("TruncatedBanner", () => {
  it("a file just over the 1 MiB cut never reads '1 MB of 1 MB'", () => {
    render(<TruncatedBanner total={1_048_600} onCopyPath={() => {}} />);
    expect(screen.getByText(/Showing the first 1 MB of 1,048,600 bytes/)).toBeInTheDocument();
  });
  it("a large file shows its rounded size", () => {
    render(<TruncatedBanner total={14_000_000} onCopyPath={() => {}} />);
    expect(screen.getByText("Showing the first 1 MB of 14 MB")).toBeInTheDocument();
  });
});
