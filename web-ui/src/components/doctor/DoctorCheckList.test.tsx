import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import type { DoctorCheckDto } from "@/api/types";
import { DoctorCheckList } from "./DoctorCheckList";
import * as copyModule from "@/lib/copyText";

const api = createMockApi();

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

const OK = (name: string, group: DoctorCheckDto["group"] = "optional"): DoctorCheckDto => ({
  name,
  status: "ok",
  required: false,
  group,
  message: `${name} fine`,
  resolvedPath: null,
  installHint: null,
});

describe("DoctorCheckList", () => {
  it("renders check name, status chip, message and resolved path; a failing legacy-hint check shows its command", () => {
    render(<DoctorCheckList api={api} checks={MOCK_CHECKS} hostname="test-host" hostOs="linux" />);

    expect(screen.getByText("git")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(screen.getByText("installed (2.39.5)")).toBeInTheDocument();
    expect(screen.getByText("/usr/bin/git")).toBeInTheDocument();

    expect(screen.getByText("tmux")).toBeInTheDocument();
    expect(screen.getByText("Missing")).toBeInTheDocument();
    expect(screen.getByText("missing from PATH")).toBeInTheDocument();
    expect(screen.queryByText(/^Run on /)).toBeNull();
    expect(screen.getByText("sudo apt install tmux")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.getByText("✓")).toBeInTheDocument();
    expect(screen.getByText("✗")).toBeInTheDocument();
  });

  it("copies the command when Copy is clicked", async () => {
    const user = userEvent.setup();
    const copySpy = vi.spyOn(copyModule, "copyText").mockResolvedValue(true);

    render(<DoctorCheckList api={api} checks={MOCK_CHECKS} hostname="test-host" hostOs="linux" />);
    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(copySpy).toHaveBeenCalledWith("sudo apt install tmux");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    copySpy.mockRestore();
  });

  it("6.T3 — foldPassing renders failing rows first, then one 'N checks passed' row", async () => {
    const user = userEvent.setup();
    const checks = [OK("git"), OK("tailscale"), MOCK_CHECKS[1]!];
    const { container } = render(
      <DoctorCheckList api={api} checks={checks} hostname="h" hostOs="linux" foldPassing />,
    );
    const names = Array.from(container.querySelectorAll(".doctor-row__name")).map((n) => n.textContent);
    expect(names).toEqual(["tmux"]);
    const fold = container.querySelector(".doctor-fold") as HTMLElement;
    expect(fold.textContent).toContain("2 checks passed");
    expect(fold.textContent).toContain("git, tailscale");

    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(Array.from(container.querySelectorAll(".doctor-row__name")).map((n) => n.textContent)).toEqual([
      "tmux",
      "git",
      "tailscale",
    ]);
  });

  it("6.T3 — filter='attention' hides OK rows (grouped view too)", () => {
    const checks = [OK("git", "required"), OK("tailscale"), MOCK_CHECKS[1]!];
    const { container, rerender } = render(
      <DoctorCheckList api={api} checks={checks} hostname="h" hostOs="linux" filter="attention" />,
    );
    expect(Array.from(container.querySelectorAll(".doctor-row__name")).map((n) => n.textContent)).toEqual(["tmux"]);

    rerender(
      <DoctorCheckList api={api} checks={checks} hostname="h" hostOs="linux" groupBy filter="attention" />,
    );
    expect(Array.from(container.querySelectorAll(".doctor-row__name")).map((n) => n.textContent)).toEqual(["tmux"]);
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.queryByText("Optional")).toBeNull();
  });

  it("R1F-03 — 'Run on <host>' caption shows only beside the OS switch", () => {
    const withSwitch: DoctorCheckDto = {
      ...MOCK_CHECKS[1]!,
      name: "tailscale",
      hint: {
        title: null,
        why: "needed",
        docsUrl: null,
        action: null,
        commands: [
          { os: "macos", command: "brew install tailscale" },
          { os: "linux", command: "curl -fsSL https://tailscale.com/install.sh | sh" },
        ],
      },
    };
    const anyOnly: DoctorCheckDto = {
      ...MOCK_CHECKS[1]!,
      name: "tmux",
      hint: {
        title: null,
        why: "needed",
        docsUrl: null,
        action: null,
        commands: [{ os: "any", command: "install tmux" }],
      },
    };
    const { unmount } = render(
      <DoctorCheckList api={api} checks={[withSwitch]} hostname="test-host" hostOs="linux" />,
    );
    expect(screen.getByText("Run on test-host (linux)")).toBeInTheDocument();
    unmount();

    render(<DoctorCheckList api={api} checks={[anyOnly]} hostname="test-host" hostOs="linux" />);
    expect(screen.getByText("install tmux")).toBeInTheDocument();
    expect(screen.queryByText(/^Run on /)).toBeNull();
  });

  it("R3F-01 — foldPassing lists failing checks by severity (Missing first), daemon order within a severity", () => {
    const mk = (name: string, status: DoctorCheckDto["status"]): DoctorCheckDto => ({
      ...OK(name),
      status,
      message: `${name} msg`,
    });
    render(
      <DoctorCheckList
        api={api}
        foldPassing
        hostname="test-host"
        hostOs="linux"
        checks={[
          mk("plugin-cursor", "warn"),
          mk("tailscale", "warn"),
          mk("github-cli", "error"),
          mk("orphan-worktrees", "warn"),
          mk("github-auth", "error"),
          mk("tmux", "ok"),
        ]}
      />,
    );
    const html = document.body.innerHTML;
    const order = ["github-cli", "github-auth", "plugin-cursor", "tailscale", "orphan-worktrees"].map((n) =>
      html.indexOf(`>${n}<`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(screen.getByText(/1 check passed/)).toBeInTheDocument();
  });
});
