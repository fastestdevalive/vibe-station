import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import type { DoctorCheckDto } from "@/api/types";
import { DoctorRow } from "./DoctorRow";
import * as copyModule from "@/lib/copyText";

const api = createMockApi();

const base: DoctorCheckDto = {
  name: "tailscale",
  status: "warn",
  required: false,
  group: "optional",
  message: "tailscale not found on PATH",
  resolvedPath: null,
  installHint: null,
};

function renderRow(check: DoctorCheckDto, hostOs = "linux") {
  return render(<DoctorRow api={api} check={check} hostOs={hostOs} hostname="box" onChanged={() => {}} />);
}

describe("DoctorRow (6.T1)", () => {
  const twoOs: DoctorCheckDto = {
    ...base,
    hint: {
      title: null,
      why: "Optional. Reach vibe-station from your phone.",
      commands: [
        { os: "macos", command: "brew install --cask tailscale" },
        { os: "linux", command: "curl -fsSL https://tailscale.com/install.sh | sh" },
      ],
      docsUrl: null,
      action: null,
    },
  };

  it("shows the host-OS command and an OS switch when macOS and Linux commands differ", async () => {
    const user = userEvent.setup();
    renderRow(twoOs, "linux");
    expect(screen.getByText("Optional. Reach vibe-station from your phone.")).toBeInTheDocument();
    expect(screen.getByText("curl -fsSL https://tailscale.com/install.sh | sh")).toBeInTheDocument();
    expect(screen.queryByText("brew install --cask tailscale")).toBeNull();

    await user.click(screen.getByRole("radio", { name: "macOS" }));
    expect(screen.getByText("brew install --cask tailscale")).toBeInTheDocument();
    expect(screen.queryByText("curl -fsSL https://tailscale.com/install.sh | sh")).toBeNull();
  });

  it("shows no OS switch for an any-only hint", () => {
    renderRow({
      ...base,
      name: "github-auth",
      hint: {
        title: null,
        why: "Sign in once so PR status can be read.",
        commands: [{ os: "any", command: "gh auth login" }],
        docsUrl: null,
        action: null,
      },
    });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByText("gh auth login")).toBeInTheDocument();
  });

  it("Copy passes the command text to copyText", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(copyModule, "copyText").mockResolvedValue(true);
    renderRow(twoOs, "linux");
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(spy).toHaveBeenCalledWith("curl -fsSL https://tailscale.com/install.sh | sh");
    spy.mockRestore();
  });

  it("shows 'Copy failed' when the clipboard write fails", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(copyModule, "copyText").mockResolvedValue(false);
    renderRow(twoOs, "linux");
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copy failed" })).toBeInTheDocument();
    spy.mockRestore();
  });

  it("an OK row shows name and resolved path but no hint", () => {
    renderRow({ ...base, status: "ok", resolvedPath: "/usr/bin/tailscale" });
    expect(screen.getByText("/usr/bin/tailscale")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
});
