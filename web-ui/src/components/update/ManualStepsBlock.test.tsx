import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { InstallResult, UpdateTarget } from "@/api/types";
import { ManualStepsBlock } from "./ManualStepsBlock";

const CMD = "curl -fsSL https://example.test/install.sh | sudo sh -s -- --install-dir /usr/local/bin";

describe("ManualStepsBlock", () => {
  it("captions the sudo command of an unwritable curl copy and lists it after 'Not updated'", async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    const result: InstallResult = {
      version: "1.2.3",
      updated: ["/home/u/.local/bin/vst"],
      manual: [{ kind: "command", text: CMD }],
    };
    const targets: UpdateTarget[] = [
      { method: "curl", path: "/home/u/.local/bin/vst", auto: true },
      { method: "curl", path: "/usr/local/bin/vst", auto: true },
    ];
    const { container } = render(
      <ManualStepsBlock
        result={result}
        targets={targets}
        onCopyCommand={onCopy}
        copiedCommand={false}
      />,
    );
    expect(screen.queryByText(/Verified package/)).toBeNull();
    const heading = screen.getByText("Not updated (manual update required):");
    const caption = screen.getByText("Run this to update them:");
    const code = screen.getByText(CMD);
    expect(
      heading.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      heading.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelectorAll(".update-dialog__step-list li")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(onCopy).toHaveBeenCalledWith(CMD);
  });

  it("still renders the deb flow with Verified package and apt install", () => {
    const result: InstallResult = {
      version: "1.2.3",
      updated: [],
      debPath: "/home/u/Downloads/vibe-station_1.2.3_amd64.deb",
      manual: [],
    };
    render(
      <ManualStepsBlock
        result={result}
        targets={[]}
        onCopyCommand={() => {}}
        copiedCommand={false}
      />,
    );
    expect(screen.getByText(/Verified package/)).toBeInTheDocument();
    expect(
      screen.getByText("sudo apt install /home/u/Downloads/vibe-station_1.2.3_amd64.deb"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Run this to update them:")).toBeNull();
  });
});
