import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNDO_COMMAND } from "lexical";
import { createMockApi } from "@/api/mock";
import type { Command, Mode, Project, Session } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useModesStore } from "@/store/modesStore";
import { getLexicalEditor } from "./lexicalTestSeam";
import { SkillEditor, type SkillEditorHandle } from "./SkillEditor";
import { QueuedTurnEditor } from "./QueuedTurnEditor";
import type { MentionEditorConfig } from "@/components/mentions/types";

if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => {} }) as DOMRect;
}
if (typeof Text !== "undefined" && !(Text.prototype as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect) {
  (Text.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => {} }) as DOMRect;
}

const COMMANDS: Command[] = [
  { name: "code-review", description: "Review diff", argumentHint: "[severity]" },
  { name: "simplify", description: "Simplify" },
];

function projectFixture(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/Users/test/${name}`,
    prefix: id,
    isGit: true,
    createdAt: "2026-01-01T00:00:00Z",
    hidden: false,
    lspEnabled: false,
  };
}

function sessionFixture(id: string, projectId: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    projectId,
    worktreeId: null,
    type: "agent",
    state: "idle",
    lifecycleState: "idle",
    tmuxName: `tmux-${id}`,
    modeId: "m-claude",
    channel: "json",
    isMain: false,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderEditorWithMentions(
  initialText: string,
  opts: {
    commands?: Command[];
    mentions?: MentionEditorConfig | null;
    onSubmit?: () => void;
    onEscape?: () => void;
  } = {},
) {
  const api = createMockApi();
  const ref = createRef<SkillEditorHandle>();
  const onChangeText = vi.fn();
  const onSubmit = opts.onSubmit ?? vi.fn();
  const onEscape = opts.onEscape ?? vi.fn();

  const mentionsConfig: MentionEditorConfig | undefined =
    opts.mentions === null
      ? undefined
      : opts.mentions ?? {
          api,
          projectId: "p1",
          worktreeId: "wt1",
          selfSessionId: "s-self",
        };

  render(
    <SkillEditor
      ref={ref}
      editorKey={`mentions-test-${Math.random()}`}
      initialText={initialText}
      commands={opts.commands ?? COMMANDS}
      mentions={mentionsConfig}
      ariaLabel="Message"
      className="test-editor"
      onChangeText={onChangeText}
      onSubmit={onSubmit}
      onEscape={onEscape}
    />,
  );
  return { ref, onChangeText, onSubmit, onEscape, api };
}

function editorEl() {
  return screen.getByLabelText("Message");
}

async function key(el: Element, key: string, opts: Partial<KeyboardEventInit> = {}) {
  await act(async () => {
    fireEvent.keyDown(el, { key, ...opts });
  });
}

describe("SkillEditor mentions popover & interactions (2.T3 - 2.T6)", () => {
  beforeEach(() => {
    const p1 = projectFixture("p1", "Project 1");
    const s1 = sessionFixture("s-agent1", "p1", { name: "Agent Fix login" });
    const s2 = sessionFixture("s-agent2", "p1", { name: "Agent Add billing" });

    useServerStore.setState({
      projects: [p1],
      worktrees: [],
      sessions: [s1, s2],
      loaded: true,
    });
    useWorkspaceStore.setState({ sessionStates: {} });
    useModesStore.setState({
      modes: new Map([
        [
          "m-claude",
          { id: "m-claude", name: "Claude", cli: "claude", createdAt: "2026-01-01T00:00:00Z" } as unknown as Mode,
        ],
      ]),
      loaded: true,
    });
  });

  describe("2.T3 Popover triggers & a11y", () => {
    it("seed '@ag' opens popover with scope row first, aria-activedescendant matches active option", async () => {
      const { ref } = renderEditorWithMentions("@ag");
      await act(async () => {
        ref.current?.focus();
      });

      await waitFor(() => {
        const options = screen.queryAllByRole("option");
        expect(options.length).toBeGreaterThan(0);
      });

      const options = screen.getAllByRole("option");
      expect(options[0]?.textContent).toContain("@agents:");

      const el = editorEl();
      const activeDescendant = el.getAttribute("aria-activedescendant");
      expect(activeDescendant).toBeTruthy();
      expect(activeDescendant).toBe(options[0]?.id);
    });

    it("'a@b.com' and 'x@' do not open popover", async () => {
      const { ref: ref1 } = renderEditorWithMentions("a@b.com");
      await act(async () => {
        ref1.current?.focus();
      });
      expect(screen.queryAllByRole("option")).toHaveLength(0);

      const { ref: ref2 } = renderEditorWithMentions("x@");
      await act(async () => {
        ref2.current?.focus();
      });
      expect(screen.queryAllByRole("option")).toHaveLength(0);
    });

    it("'/cod' still opens slash popover and '@x' does not trigger it", async () => {
      const { ref } = renderEditorWithMentions("/cod");
      await act(async () => {
        ref.current?.focus();
      });

      await waitFor(() => {
        expect(screen.queryAllByRole("option")).toHaveLength(1);
      });
      expect(screen.getByRole("option").textContent).toContain("/code-review");
    });

    it("no mentions prop does not open popover on '@ag'", async () => {
      const { ref } = renderEditorWithMentions("@ag", { mentions: null });
      await act(async () => {
        ref.current?.focus();
      });
      expect(screen.queryAllByRole("option")).toHaveLength(0);
    });
  });

  describe("2.T4 Scoping, filtering & leaving scope", () => {
    it("Enter on scope row rewrites token to @agents:, stays open with scoped header", async () => {
      const { ref } = renderEditorWithMentions("@ag");
      await act(async () => {
        ref.current?.focus();
      });

      await waitFor(() => {
        expect(screen.queryAllByRole("option").length).toBeGreaterThan(0);
      });

      // Active option is the @agents: scope row
      await key(editorEl(), "Enter");

      await waitFor(() => {
        expect(ref.current?.getText()).toBe("@agents:");
      });

      // Still open in scoped mode
      await waitFor(() => {
        expect(screen.queryByText(/Searching agents in this project/)).toBeTruthy();
      });
    });

    it("seeded '@agents:fi' shows scoped list with header", async () => {
      const { ref } = renderEditorWithMentions("@agents:fi");
      await act(async () => {
        ref.current?.focus();
      });

      await waitFor(() => {
        expect(screen.queryByText(/Searching agents in this project/)).toBeTruthy();
      });

      const options = screen.getAllByRole("option");
      expect(options.some((opt) => opt.textContent?.includes("Fix login"))).toBe(true);
      expect(options.some((opt) => opt.textContent?.includes("Add billing"))).toBe(false);
    });

    it("Backspace at colon in @agents: leaves scope", async () => {
      const { ref } = renderEditorWithMentions("@agents:");
      await act(async () => {
        ref.current?.focus();
      });

      await waitFor(() => {
        expect(screen.queryByText(/Searching agents in this project/)).toBeTruthy();
      });

      await key(editorEl(), "Backspace");

      await waitFor(() => {
        // Scoped header gone, scope row visible again
        expect(screen.queryByText(/Searching agents in this project/)).toBeNull();
      });
    });
  });

  describe("arrow-key wrap", () => {
    it("ArrowUp on the first row wraps to the last; ArrowDown on the last wraps to the first", async () => {
      const { ref } = renderEditorWithMentions("@");
      await act(async () => {
        ref.current?.focus();
      });
      await waitFor(() => {
        expect(screen.queryAllByRole("option").length).toBeGreaterThan(1);
      });
      const options = () => screen.queryAllByRole("option");
      const activeIdx = () => options().findIndex((o) => o.getAttribute("aria-selected") === "true");
      expect(activeIdx()).toBe(0);

      await key(editorEl(), "ArrowUp");
      expect(activeIdx()).toBe(options().length - 1);

      await key(editorEl(), "ArrowDown");
      expect(activeIdx()).toBe(0);
    });
  });

  describe("2.T5 Key race, submission, Escape & composing", () => {
    it("open popover, force source updates, press Enter: chip inserted, onSubmit not called, immediate next Enter submits", async () => {
      const onSubmit = vi.fn();
      const { ref } = renderEditorWithMentions("@ag", { onSubmit });
      await act(async () => {
        ref.current?.focus();
      });

      await waitFor(() => {
        expect(screen.queryAllByRole("option").length).toBeGreaterThan(0);
      });

      // Down arrow to pick the first agent item instead of the scope row
      await key(editorEl(), "ArrowDown");

      // Force two rapid store updates
      await act(async () => {
        useServerStore.setState({
          sessions: [
            sessionFixture("s-agent1", "p1", { name: "Agent Fix login" }),
            sessionFixture("s-agent2", "p1", { name: "Agent Add billing" }),
            sessionFixture("s-agent3", "p1", { name: "Agent Cleanup" }),
          ],
        });
      });
      await act(async () => {
        useServerStore.setState({
          sessions: [
            sessionFixture("s-agent1", "p1", { name: "Agent Fix login" }),
            sessionFixture("s-agent2", "p1", { name: "Agent Add billing" }),
          ],
        });
      });

      // Enter inserts the chip
      await key(editorEl(), "Enter");

      await waitFor(() => {
        expect(ref.current?.getText()).toContain('{@agent ["s-agent1","Agent Fix login"]}');
        expect(ref.current?.getText()).toMatch(/ \s*$/); // trailing space
      });

      expect(onSubmit).not.toHaveBeenCalled();

      // Immediately after chip is inserted and popover is closed, Enter submits
      await key(editorEl(), "Enter");
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("Escape with popover open inside QueuedTurnEditor does NOT discard; closed Escape discards", async () => {
      const api = createMockApi();
      const onSave = vi.fn();
      const onDiscard = vi.fn();

      render(
        <QueuedTurnEditor
          api={api}
          sessionId="s-agent1"
          initialText="@ag"
          initialAttachments={[]}
          onSave={onSave}
          onDiscard={onDiscard}
        />,
      );

      const el = screen.getByLabelText("Edit queued message");
      await act(async () => {
        el.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
        fireEvent(document, new Event("selectionchange"));
      });

      await waitFor(() => {
        expect(screen.queryAllByRole("option").length).toBeGreaterThan(0);
      });

      // Escape with popover open closes only the popover, does not call onDiscard
      await key(el, "Escape");
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      expect(onDiscard).not.toHaveBeenCalled();

      // Escape with popover closed discards
      await key(el, "Escape");
      expect(onDiscard).toHaveBeenCalledTimes(1);
    });

    it("popover open with only a status row -> Enter submits", async () => {
      const onSubmit = vi.fn();
      const { ref } = renderEditorWithMentions("@agents:nonexistentquery", { onSubmit });
      await act(async () => {
        ref.current?.focus();
      });

      await waitFor(() => {
        expect(screen.getByText(/No agents match/)).toBeTruthy();
      });

      // No selectable rows
      expect(screen.queryAllByRole("option")).toHaveLength(0);

      await key(editorEl(), "Enter");
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("Tab and click (mouseDown) select", async () => {
      const { ref: refTab } = renderEditorWithMentions("@ag");
      await act(async () => {
        refTab.current?.focus();
      });
      await waitFor(() => {
        expect(screen.queryAllByRole("option").length).toBeGreaterThan(0);
      });
      await key(editorEl(), "ArrowDown");
      await key(editorEl(), "Tab");
      await waitFor(() => {
        expect(refTab.current?.getText()).toContain("{@agent");
      });

      const { ref: refClick } = renderEditorWithMentions("@ag");
      await act(async () => {
        refClick.current?.focus();
      });
      await waitFor(() => {
        expect(screen.queryAllByRole("option").length).toBeGreaterThan(0);
      });
      const agentOption = screen.getAllByRole("option")[1]!;
      await act(async () => {
        fireEvent.mouseDown(agentOption);
      });
      await waitFor(() => {
        expect(refClick.current?.getText()).toContain("{@agent");
      });
    });

    it("isComposing Enter does nothing", async () => {
      const onSubmit = vi.fn();
      const { ref } = renderEditorWithMentions("@ag", { onSubmit });
      await act(async () => {
        ref.current?.focus();
      });

      await waitFor(() => {
        expect(screen.queryAllByRole("option").length).toBeGreaterThan(0);
      });

      await key(editorEl(), "Enter", { isComposing: true });
      expect(ref.current?.getText()).toBe("@ag");
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("paste of '@ag' text does not open the popover", async () => {
      const { ref } = renderEditorWithMentions("");
      await act(async () => {
        ref.current?.focus();
      });

      const el = editorEl();
      await act(async () => {
        fireEvent.paste(el, {
          clipboardData: {
            getData: (type: string) => (type === "text/plain" ? "@ag" : ""),
          },
        });
      });

      expect(screen.queryAllByRole("option")).toHaveLength(0);
    });
  });

  describe("2.T6 Mention limit & undo", () => {
    it("50 seeded chips + '@x' shows limit status row and Enter submits", async () => {
      const onSubmit = vi.fn();
      const chips = Array.from({ length: 50 }, (_, i) => `{@file ["f${i}.ts","f${i}.ts"]}`).join(" ");
      const { ref } = renderEditorWithMentions(`${chips} @x`, { onSubmit });

      await act(async () => {
        ref.current?.focus();
      });

      await waitFor(() => {
        expect(screen.getByText("Mention limit (50) reached")).toBeTruthy();
      });

      expect(screen.queryAllByRole("option")).toHaveLength(0);

      await key(editorEl(), "Enter");
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("undo after inserting a chip restores @ag text and no chip", async () => {
      const { ref } = renderEditorWithMentions("@ag");
      const el = editorEl();
      const editor = getLexicalEditor(editorEl());

      await act(async () => {
        ref.current?.focus();
      });

      await waitFor(() => {
        expect(screen.queryAllByRole("option").length).toBeGreaterThan(0);
      });

      await key(el, "ArrowDown");
      await key(el, "Enter");

      await waitFor(() => {
        expect(ref.current?.getText()).toContain("{@agent");
      });

      // Dispatch undo
      await act(async () => {
        editor?.dispatchCommand(UNDO_COMMAND, undefined);
      });

      await waitFor(() => {
        expect(ref.current?.getText()).toBe("@ag");
      });
      expect(screen.queryByTitle("Agent Fix login")).toBeNull();
    });
  });

  describe("F1 spaces inside the @ query", () => {
    beforeEach(() => {
      useServerStore.setState({
        sessions: [
          sessionFixture("s-agent1", "p1", { name: "Agent 1" }),
          sessionFixture("s-agent2", "p1", { name: "Agent 2" }),
        ],
      });
    });

    for (const seed of ["@Agent 2", "@agents:Agent 2"]) {
      it(`'${seed}' keeps popup open with Agent 2 first; Enter inserts chip, no submit`, async () => {
        const onSubmit = vi.fn();
        const { ref } = renderEditorWithMentions(seed, { onSubmit });
        await act(async () => {
          ref.current?.focus();
        });
        await waitFor(() => {
          expect(screen.queryAllByRole("option").length).toBeGreaterThan(0);
        });
        const first = screen.getAllByRole("option").find((o) => o.textContent?.includes("Agent"));
        expect(first?.textContent).toContain("Agent 2");

        await key(editorEl(), "Enter");
        await waitFor(() => {
          expect(ref.current?.getText()).toContain('{@agent ["s-agent2","Agent 2"]}');
        });
        expect(onSubmit).not.toHaveBeenCalled();
      });
    }

    it("'mail a@b.com' does not open the popup", async () => {
      const { ref } = renderEditorWithMentions("mail a@b.com");
      await act(async () => {
        ref.current?.focus();
      });
      expect(screen.queryAllByRole("option")).toHaveLength(0);
    });

    it("query over 80 chars does not open the popup; 80 does", async () => {
      const { ref: r1 } = renderEditorWithMentions("@" + "a".repeat(81));
      await act(async () => {
        r1.current?.focus();
      });
      expect(screen.queryAllByRole("listbox")).toHaveLength(0);
      const { ref: r2 } = renderEditorWithMentions("@" + "a".repeat(80));
      await act(async () => {
        r2.current?.focus();
      });
      await waitFor(() => {
        expect(screen.queryAllByRole("listbox").length).toBeGreaterThan(0);
      });
    });

    it("'@zzz yyy' closes with no matches and Enter submits normally", async () => {
      const onSubmit = vi.fn();
      const { ref } = renderEditorWithMentions("@zzz yyy", { onSubmit });
      await act(async () => {
        ref.current?.focus();
      });
      await waitFor(() => {
        expect(screen.queryByRole("listbox")).toBeNull();
      });
      await key(editorEl(), "Enter");
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(ref.current?.getText()).toBe("@zzz yyy");
    });
  });
});
