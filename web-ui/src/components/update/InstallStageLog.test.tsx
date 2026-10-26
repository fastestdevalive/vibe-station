import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { InstallProgressBody } from "./UpdateDialogParts";

describe("InstallProgressBody stage log", () => {
  it("verifying: earlier stages done, current stage active, log is not a live region", () => {
    const { container } = render(<InstallProgressBody stage="verifying" pct={100} startedBy="ui" />);
    const items = [...container.querySelectorAll(".update-dialog__stage-log li")];
    expect(items.map((li) => li.textContent)).toEqual([
      "✓ Checked prerequisites",
      "✓ Downloaded",
      "Verifying checksum",
    ]);
    expect(screen.getByText("✓ Downloaded")).toHaveAttribute("data-state", "done");
    expect(screen.getByText("Verifying checksum")).toHaveAttribute("data-state", "active");
    expect(container.querySelector(".update-dialog__stage-log")).not.toHaveAttribute("aria-live");
    expect(container.querySelector("[aria-live]")).toBeNull();
  });

  it("preflight shows a single entry", () => {
    const { container } = render(<InstallProgressBody stage="preflight" pct={0} startedBy="ui" />);
    expect(container.querySelectorAll(".update-dialog__stage-log li")).toHaveLength(1);
  });
});
