import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { QueuedTurnEditor } from "./QueuedTurnEditor";

/** See the note at the top of Composer.test.tsx: jsdom cannot drive real
 *  typing into the Lexical contenteditable, so `initialText` seeds the
 *  final document and a chip's native arg `<input>` (fully testable) stands
 *  in for edits. */
async function keyAsync(el: Element, key: string, opts: Partial<KeyboardEventInit> = {}) {
  await act(async () => {
    fireEvent.keyDown(el, { key, ...opts });
  });
}

const SKILL_COMMANDS = [
  { name: "code-review", description: "Review code for bugs", argumentHint: "[severity]" },
];

describe("QueuedTurnEditor: initialText already carries a skill invocation", () => {
  it("the chip renders on mount with its args and the trailing prose", () => {
    const api = createMockApi();
    render(
      <QueuedTurnEditor
        api={api}
        sessionId="s1"
        initialText={"{/code-review high}and open a PR"}
        initialAttachments={[]}
        onSave={vi.fn()}
        onDiscard={vi.fn()}
        commands={SKILL_COMMANDS}
      />,
    );

    expect(screen.getByText("/code-review")).toBeTruthy();
    const argInput = screen.getByLabelText("Arguments for code-review") as HTMLInputElement;
    expect(argInput.value).toBe("high");
    // An <input>'s value isn't part of the DOM's textContent — only the
    // static pill label ("/code-review") and the trailing prose are.
    expect(screen.getByLabelText("Edit queued message").textContent).toBe("/code-reviewand open a PR");
  });

  it("Save re-enqueues the exact wire string", async () => {
    const api = createMockApi();
    const onSave = vi.fn<(m: string, a: unknown[]) => Promise<void>>(() => Promise.resolve());
    render(
      <QueuedTurnEditor
        api={api}
        sessionId="s1"
        initialText={"{/code-review high}and open a PR"}
        initialAttachments={[]}
        onSave={onSave}
        onDiscard={vi.fn()}
        commands={SKILL_COMMANDS}
      />,
    );
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toBe("{/code-review high}and open a PR");
  });
});

describe("QueuedTurnEditor canSave with a parked empty skill chip (Decision 5 / M2)", () => {
  it("Save is ENABLED with an empty-args, empty-prose parked chip (M2: /code-review alone is savable)", async () => {
    const api = createMockApi();
    const onSave = vi.fn<(m: string, a: unknown[]) => Promise<void>>(() => Promise.resolve());
    render(
      <QueuedTurnEditor
        api={api}
        sessionId="s1"
        initialText={"{/code-review}"}
        initialAttachments={[]}
        onSave={onSave}
        onDiscard={vi.fn()}
        commands={SKILL_COMMANDS}
      />,
    );
    expect(screen.getByText("Save")).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("{/code-review}", []));
  });

  it("Save stays enabled once args are typed (via the chip's arg input)", async () => {
    const api = createMockApi();
    render(
      <QueuedTurnEditor
        api={api}
        sessionId="s1"
        initialText={"{/code-review}"}
        initialAttachments={[]}
        onSave={vi.fn()}
        onDiscard={vi.fn()}
        commands={SKILL_COMMANDS}
      />,
    );
    const argInput = screen.getByLabelText("Arguments for code-review") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(argInput, { target: { value: "high" } });
    });
    expect(screen.getByText("Save")).toHaveProperty("disabled", false);
  });

  it("Save is disabled with nothing typed and no attachments", () => {
    const api = createMockApi();
    render(
      <QueuedTurnEditor
        api={api}
        sessionId="s1"
        initialText=""
        initialAttachments={[]}
        onSave={vi.fn()}
        onDiscard={vi.fn()}
        commands={SKILL_COMMANDS}
      />,
    );
    expect(screen.getByText("Save")).toHaveProperty("disabled", true);
  });
});

describe("Enter/Escape/Ctrl+Enter never leak out of the arg input (spec §10)", () => {
  it("Enter in the arg input never saves — exits to after-chip instead", async () => {
    const api = createMockApi();
    const onSave = vi.fn();
    render(
      <QueuedTurnEditor
        api={api}
        sessionId="s1"
        initialText={"{/code-review high}and open a PR"}
        initialAttachments={[]}
        onSave={onSave}
        onDiscard={vi.fn()}
        commands={SKILL_COMMANDS}
      />,
    );
    const argInput = screen.getByLabelText("Arguments for code-review");
    fireEvent.focus(argInput);
    await keyAsync(argInput, "Enter");
    expect(onSave).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(argInput);
  });

  it("Escape in the arg input does not discard the edit", async () => {
    const api = createMockApi();
    const onDiscard = vi.fn();
    render(
      <QueuedTurnEditor
        api={api}
        sessionId="s1"
        initialText={"{/code-review high}and open a PR"}
        initialAttachments={[]}
        onSave={vi.fn()}
        onDiscard={onDiscard}
        commands={SKILL_COMMANDS}
      />,
    );
    const argInput = screen.getByLabelText("Arguments for code-review");
    fireEvent.focus(argInput);
    await keyAsync(argInput, "Escape");
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("Escape with NO popover open and focus in the editor body DOES discard (QueuedTurnEditor's own onEscape)", async () => {
    const api = createMockApi();
    const onDiscard = vi.fn();
    render(
      <QueuedTurnEditor
        api={api}
        sessionId="s1"
        initialText="plain prose, no chip"
        initialAttachments={[]}
        onSave={vi.fn()}
        onDiscard={onDiscard}
        commands={SKILL_COMMANDS}
      />,
    );
    await keyAsync(screen.getByLabelText("Edit queued message"), "Escape");
    expect(onDiscard).toHaveBeenCalled();
  });

  it("Ctrl+Enter in the arg input delegates to Save", async () => {
    const api = createMockApi();
    const onSave = vi.fn<(m: string, a: unknown[]) => Promise<void>>(() => Promise.resolve());
    render(
      <QueuedTurnEditor
        api={api}
        sessionId="s1"
        initialText={"{/code-review high}"}
        initialAttachments={[]}
        onSave={onSave}
        onDiscard={vi.fn()}
        commands={SKILL_COMMANDS}
      />,
    );
    const argInput = screen.getByLabelText("Arguments for code-review");
    fireEvent.focus(argInput);
    await keyAsync(argInput, "Enter", { ctrlKey: true });
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });
});
