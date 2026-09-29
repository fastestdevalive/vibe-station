import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import type { DoctorCheckDto } from "@/api/types";
import { DoctorCheckList } from "./DoctorCheckList";
import * as copyModule from "@/lib/copyText";

const MOCK_CHECKS: DoctorCheckDto[] = [
  {
    name: "git",
    status: "ok",
    required: true,
    group: "required",
    message: "installed (2.39.5)",
    resolvedPath: "/usr/bin/git",
    installHint: null,
  },
  {
    name: "tmux",
    status: "error",
    required: true,
    group: "required",
    message: "missing from PATH",
    resolvedPath: null,
    installHint: "sudo apt install tmux",
  },
];

describe("DoctorCheckList", () => {
  it("renders check name, status string, resolved message on the left and glyph on the right", () => {
    const { container } = render(
      <DoctorCheckList
        checks={MOCK_CHECKS}
        hostname="test-host"
        hostOs="linux"
      />
    );

    // Verify git row
    expect(screen.getByText("git")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(screen.getByText("installed (2.39.5)")).toBeInTheDocument();
    expect(screen.getByText("Resolved: /usr/bin/git")).toBeInTheDocument();

    // Verify tmux row
    expect(screen.getByText("tmux")).toBeInTheDocument();
    expect(screen.getByText("Missing")).toBeInTheDocument();
    expect(screen.getByText("missing from PATH")).toBeInTheDocument();
    expect(screen.getByText("Run on test-host (linux):")).toBeInTheDocument();
    expect(screen.getByText("sudo apt install tmux")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();

    // Verify glyphs exist
    expect(screen.getByText("✓")).toBeInTheDocument();
    expect(screen.getByText("✗")).toBeInTheDocument();

    // Check flex row layout: status badge box (glyph + label) is on the right side
    const rows = container.querySelectorAll("div[style*='justify-content: space-between']");
    expect(rows).toHaveLength(2);
    const gitRow = rows[0];
    expect(gitRow).toBeDefined();
    const rightSide = gitRow?.lastElementChild;
    expect(rightSide).toHaveTextContent("✓");
    expect(rightSide).toHaveTextContent("OK");

    const tmuxRow = rows[1];
    expect(tmuxRow?.lastElementChild).toHaveTextContent("✗");
    expect(tmuxRow?.lastElementChild).toHaveTextContent("Missing");
  });

  it("copies installHint when copy button is clicked", async () => {
    const user = userEvent.setup();
    const copySpy = vi.spyOn(copyModule, "copyText").mockResolvedValue(true);

    render(
      <DoctorCheckList
        checks={MOCK_CHECKS}
        hostname="test-host"
        hostOs="linux"
      />
    );

    const copyBtn = screen.getByRole("button", { name: "Copy" });
    await user.click(copyBtn);

    expect(copySpy).toHaveBeenCalledWith("sudo apt install tmux");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    copySpy.mockRestore();
  });
});
