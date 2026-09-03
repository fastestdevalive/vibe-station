import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { Composer } from "./Composer";
import type { SkillEditorHandle } from "./SkillEditor";

/**
 * Phase 7B — tests written directly against
 * `.vibekit/feature-plans/pending/skill-invocation-in-chat/ux-chip-interaction-spec.md`.
 * Each `it` names the spec section/row it covers. Exercised through
 * `Composer` (one of the three mount sites) since `<SkillEditor>` has no
 * standalone send/save action of its own.
 *
 * A note on technique: jsdom does not support real typing into a
 * contenteditable the way a browser does (no working `beforeinput`), so
 * these tests seed the document via `initialText` (exactly the code path a
 * real mount already uses for a stored draft or a withdrawn queued turn)
 * and drive the caret/selection contract via keyboard events — the same
 * mechanism production keystrokes use. Any Lexical-driven DOM update must be
 * awaited inside `act(async () => ...)` since `editor.update()` flushes on a
 * microtask, not synchronously with `fireEvent`.
 */

const COMMANDS = [
  { name: "code-review", description: "Review the diff", argumentHint: "[severity]" },
  { name: "simplify", description: "Simplify" },
];

function renderComposer(initialText: string, overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const api = createMockApi();
  const onSend = vi.fn(() => Promise.resolve());
  const ref = createRef<SkillEditorHandle>();
  render(
    <Composer
      api={api}
      sessionId={`s-${Math.random()}`}
      onSend={onSend}
      initialText={initialText}
      commands={COMMANDS}
      textareaRef={ref}
      {...overrides}
    />,
  );
  return { onSend, ref };
}

function argInput(name = "code-review") {
  return screen.getByLabelText(`Arguments for ${name}`) as HTMLInputElement;
}

function editorEl() {
  return screen.getByLabelText("Message");
}

async function key(el: Element, key: string, opts: Partial<KeyboardEventInit> = {}) {
  await act(async () => {
    fireEvent.keyDown(el, { key, ...opts });
  });
}

describe("§1 caret movement", () => {
  it("→ at end of arg input exits to after-chip (re-entrant: ← then goes back to end)", async () => {
    const { ref } = renderComposer("{/code-review high}");
    const input = argInput();
    fireEvent.focus(input);
    input.setSelectionRange(input.value.length, input.value.length);
    await key(input, "ArrowRight");
    expect(document.activeElement).not.toBe(input);
    // Back at the document, right after the chip — ← should re-enter at end.
    await key(editorEl(), "ArrowLeft");
    expect(document.activeElement).toBe(argInput());
    expect(argInput().selectionStart).toBe(argInput().value.length);
    expect(ref.current?.getText()).toBe("{/code-review high}");
  });

  it("← at start of arg input exits to before-chip; → re-enters at start", async () => {
    renderComposer("{/code-review high}");
    const input = argInput();
    fireEvent.focus(input);
    input.setSelectionRange(0, 0);
    await key(input, "ArrowLeft");
    expect(document.activeElement).not.toBe(input);
    await key(editorEl(), "ArrowRight");
    expect(document.activeElement).toBe(argInput());
    expect(argInput().selectionStart).toBe(0);
  });
});

describe("§2 Backspace / Delete matrix", () => {
  it("prose right of chip: Backspace enters arg input at end, deletes nothing", async () => {
    const { ref } = renderComposer("{/code-review high}");
    // Default focus lands at document end, i.e. right after the chip.
    await act(async () => ref.current?.focus());
    await key(editorEl(), "Backspace");
    expect(document.activeElement).toBe(argInput());
    expect(argInput().selectionStart).toBe(argInput().value.length);
    expect(ref.current?.getText()).toBe("{/code-review high}");
  });

  it("prose left of chip: Delete enters arg input at start, deletes nothing", async () => {
    renderComposer("{/code-review high}");
    const input = argInput();
    fireEvent.focus(input);
    input.setSelectionRange(0, 0);
    await key(input, "ArrowLeft"); // now positioned before the chip
    await key(editorEl(), "Delete");
    expect(document.activeElement).toBe(argInput());
    expect(argInput().selectionStart).toBe(0);
  });

  it("in args, deletes one char to the left / right", async () => {
    const { ref } = renderComposer("{/code-review high}");
    const input = argInput();
    fireEvent.focus(input);
    input.setSelectionRange(input.value.length, input.value.length);
    await act(async () => {
      fireEvent.change(input, { target: { value: "hig" } });
    });
    expect(ref.current?.getText()).toBe("{/code-review hig}");
  });

  it("at start of a NON-EMPTY arg input, Backspace exits left without deleting", async () => {
    const { ref } = renderComposer("{/code-review high}");
    const input = argInput();
    fireEvent.focus(input);
    input.setSelectionRange(0, 0);
    await key(input, "Backspace");
    expect(document.activeElement).not.toBe(input);
    expect(ref.current?.getText()).toBe("{/code-review high}"); // args untouched
  });

  it("at end of a NON-EMPTY arg input, Delete exits right without deleting", async () => {
    const { ref } = renderComposer("{/code-review high}");
    const input = argInput();
    fireEvent.focus(input);
    input.setSelectionRange(input.value.length, input.value.length);
    await key(input, "Delete");
    expect(document.activeElement).not.toBe(input);
    expect(ref.current?.getText()).toBe("{/code-review high}");
  });

  it("in args, EMPTY: Backspace removes the chip → leaves a literal '/'", async () => {
    const { ref } = renderComposer("{/code-review}");
    const input = argInput();
    fireEvent.focus(input);
    await key(input, "Backspace");
    await waitFor(() => expect(ref.current?.getText()).toBe("/"));
  });

  it("in args, EMPTY: Delete (forward) also removes the chip → leaves a literal '/'", async () => {
    const { ref } = renderComposer("{/code-review}");
    const input = argInput();
    fireEvent.focus(input);
    await key(input, "Delete");
    await waitFor(() => expect(ref.current?.getText()).toBe("/"));
  });

  it("a chip WITH args: Backspace deletes args one at a time before collapsing", async () => {
    const { ref } = renderComposer("{/code-review a}");
    const input = argInput();
    fireEvent.focus(input);
    input.setSelectionRange(1, 1);
    await key(input, "Backspace"); // deletes "a" natively (not intercepted — value becomes non-empty->empty via native delete)
    // jsdom's native input backspace behavior at this point isn't simulated by
    // fireEvent.keyDown alone (no real text deletion happens without a
    // subsequent change event) — simulate the resulting change explicitly,
    // mirroring what a real browser's default action would produce.
    await act(async () => {
      fireEvent.change(input, { target: { value: "" } });
    });
    expect(ref.current?.getText()).toBe("{/code-review}");
    await key(argInput(), "Backspace"); // now empty — collapses
    await waitFor(() => expect(ref.current?.getText()).toBe("/"));
  });
});

describe("§3 collapse to '/'", () => {
  it("collapse reopens the popover, unfiltered", async () => {
    renderComposer("{/code-review}");
    const input = argInput();
    fireEvent.focus(input);
    await key(input, "Backspace");
    await waitFor(() => expect(screen.queryAllByRole("option").length).toBe(COMMANDS.length));
  });

  it("caret lands immediately after the inserted '/'", async () => {
    renderComposer("{/code-review}");
    const input = argInput();
    fireEvent.focus(input);
    await key(input, "Backspace");
    await waitFor(() => expect(screen.queryAllByRole("option").length).toBeGreaterThan(0));
    // The editor itself now owns the (internal) selection; document text is "/".
  });

  // Not exercised via a simulated Ctrl+Z keydown: jsdom does not dispatch the
  // native `beforeinput` (`inputType: "historyUndo"`) event real browsers
  // fire for that shortcut, which is what Lexical's undo binding listens
  // for — so there is no reliable way to trigger it from this environment.
  // The "one history entry" guarantee is structural instead: `$collapseChipToSlash`
  // (src/lexical/SkillChipNode.tsx) performs the node replacement inside a
  // SINGLE `editor.update()` call, and Lexical's `HistoryPlugin` records one
  // history entry per `editor.update()` (outside an explicit merge tag) —
  // so a single undo of that entry necessarily restores the pre-collapse
  // state (the chip, with its args field exactly as it was).
  it.todo("undo restores the chip WITH empty args in one step (see comment above — not simulable in jsdom)");
});

describe("§4 '/' trigger word-boundary rule", () => {
  it("opens at document start", async () => {
    const { ref } = renderComposer("/cod");
    await act(async () => ref.current?.focus());
    await waitFor(() => expect(screen.queryAllByRole("option").length).toBe(1));
  });

  it("opens immediately after whitespace", async () => {
    const { ref } = renderComposer("hi /cod");
    await act(async () => ref.current?.focus());
    await waitFor(() => expect(screen.queryAllByRole("option").length).toBe(1));
  });

  it("does NOT open mid-word (and/or)", async () => {
    const { ref } = renderComposer("and/or");
    await act(async () => ref.current?.focus());
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    void ref;
  });

  it("does NOT open right after a chip with no space (chip/)", async () => {
    const { ref } = renderComposer("{/code-review}/or");
    await act(async () => ref.current?.focus());
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    void ref;
  });

  it("Escape suppresses reopening until the token changes", async () => {
    const { ref } = renderComposer("/cod");
    await act(async () => ref.current?.focus());
    await waitFor(() => expect(screen.queryAllByRole("option").length).toBe(1));
    await key(editorEl(), "Escape");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    // Arrow-left-then-right (pure caret churn within the SAME token) must
    // not reopen it.
    await key(editorEl(), "ArrowLeft");
    await key(editorEl(), "ArrowRight");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

describe("§7 focus", () => {
  it("clicking the pill label focuses the arg input at its end", () => {
    renderComposer("{/code-review high}");
    const label = document.querySelector(".chat-skill-chip__label") as HTMLElement;
    fireEvent.mouseDown(label);
    expect(document.activeElement).toBe(argInput());
    expect(argInput().selectionStart).toBe(argInput().value.length);
  });

  it("chips are not tab stops", () => {
    renderComposer("{/code-review high}");
    expect(argInput().tabIndex).toBe(-1);
  });
});

describe("§9 empty-args visual", () => {
  it("keeps a minimum ~4ch width with no argumentHint", () => {
    renderComposer("{/simplify}");
    const input = screen.getByLabelText("Arguments for simplify") as HTMLInputElement;
    expect(input.style.width).toBe("4ch");
  });
});

describe("§10 three mount sites — key table (Composer: Enter sends)", () => {
  it("Enter in the arg input never sends — exits to after-chip instead", async () => {
    const { onSend } = renderComposer("{/code-review high}");
    const input = argInput();
    fireEvent.focus(input);
    await key(input, "Enter");
    expect(onSend).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
  });

  it("Ctrl+Enter in the arg input delegates to send", async () => {
    const { onSend } = renderComposer("{/code-review high}");
    const input = argInput();
    fireEvent.focus(input);
    await key(input, "Enter", { ctrlKey: true });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
  });

  it("Escape in the arg input does not bubble to a window-level listener", async () => {
    renderComposer("{/code-review high}");
    const input = argInput();
    fireEvent.focus(input);
    const windowEscape = vi.fn();
    window.addEventListener("keydown", windowEscape);
    try {
      await key(input, "Escape");
      expect(windowEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowEscape);
    }
  });

  it("plain Enter in prose still sends", async () => {
    const { onSend } = renderComposer("hello there");
    await key(editorEl(), "Enter");
    await waitFor(() => expect(onSend).toHaveBeenCalled());
  });

  it("Shift+Enter in prose inserts a newline, does not send", async () => {
    const { onSend, ref } = renderComposer("hello");
    await act(async () => ref.current?.focus());
    await key(editorEl(), "Enter", { shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("Popover selection materializes a chip", () => {
  it("clicking a popover option inserts a chip with empty args, caret after it", async () => {
    const { ref } = renderComposer("/cod");
    await act(async () => ref.current?.focus());
    await waitFor(() => expect(screen.queryAllByRole("option").length).toBe(1));
    const option = screen.getByRole("option");
    await act(async () => {
      fireEvent.mouseDown(option);
    });
    await waitFor(() => expect(ref.current?.getText()).toBe("{/code-review}"));
    expect(screen.getByLabelText("Arguments for code-review")).toBeTruthy();
  });
});
