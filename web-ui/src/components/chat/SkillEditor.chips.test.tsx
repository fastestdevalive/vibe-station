import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { $getRoot, $nodesOfType } from "lexical";
import { getLexicalEditor } from "./lexicalTestSeam";
import { SkillEditor, type SkillEditorHandle } from "./SkillEditor";
import { MentionChipNode } from "@/lexical/MentionChipNode";

if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => {} }) as DOMRect;
}
if (typeof Text !== "undefined" && !(Text.prototype as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect) {
  (Text.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => {} }) as DOMRect;
}

function renderEditor(initialText: string) {
  const ref = createRef<SkillEditorHandle>();
  const onChangeText = vi.fn();
  const onSubmit = vi.fn();
  render(
    <SkillEditor
      ref={ref}
      editorKey={`chips-test-${Math.random()}`}
      initialText={initialText}
      ariaLabel="Message"
      className="test-editor"
      onChangeText={onChangeText}
      onSubmit={onSubmit}
    />,
  );
  return { ref, onChangeText, onSubmit };
}

function editorEl() {
  return screen.getByLabelText("Message");
}

async function key(el: Element, key: string, opts: Partial<KeyboardEventInit> = {}) {
  await act(async () => {
    fireEvent.keyDown(el, { key, ...opts });
  });
}

describe("SkillEditor mention chips (2.T1)", () => {
  it("renders seeded chip with title=id, getText() returns token, getWire() returns wire text + mentions", () => {
    const { ref } = renderEditor('x {@file ["src/a.ts","a.ts"]} y');
    const chip = screen.getByTitle("src/a.ts");
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain("a.ts");

    expect(ref.current?.getText()).toBe('x {@file ["src/a.ts","a.ts"]} y');
    expect(ref.current?.getWire()).toEqual({
      text: "x @src/a.ts y",
      mentions: [{ kind: "file", id: "src/a.ts", label: "a.ts" }],
    });
  });

  it("one Backspace right after chip removes the whole chip", async () => {
    const { ref } = renderEditor('x {@file ["src/a.ts","a.ts"]} y');
    expect(screen.getByTitle("src/a.ts")).toBeTruthy();

    const editor = getLexicalEditor(editorEl());
    expect(editor).toBeTruthy();

    await act(async () => {
      editor?.update(() => {
        const chips = $nodesOfType(MentionChipNode);
        chips[0]?.selectNext(0, 0);
      });
    });

    const el = editorEl();
    await key(el, "Backspace");
    expect(screen.queryByTitle("src/a.ts")).toBeNull();
    expect(ref.current?.getText()).toBe("x  y");
  });

  it("ArrowRight and ArrowLeft jump over the chip without deleting", async () => {
    const { ref } = renderEditor('x {@file ["src/a.ts","a.ts"]} y');
    const el = editorEl();
    const editor = getLexicalEditor(editorEl());
    expect(editor).toBeTruthy();

    // Select before chip
    await act(async () => {
      editor?.update(() => {
        const chips = $nodesOfType(MentionChipNode);
        chips[0]?.selectPrevious();
      });
    });

    await key(el, "ArrowRight");
    expect(screen.getByTitle("src/a.ts")).toBeTruthy();

    await key(el, "ArrowLeft");
    expect(screen.getByTitle("src/a.ts")).toBeTruthy();
    expect(ref.current?.getText()).toBe('x {@file ["src/a.ts","a.ts"]} y');
  });

  it("copy range containing a chip sets application/x-vst-skill-tokens and text/plain", async () => {
    const { ref } = renderEditor('x {@file ["src/a.ts","a.ts"]} y');
    const el = editorEl();
    const editor = getLexicalEditor(editorEl());
    expect(editor).toBeTruthy();

    // Select all content in Lexical
    await act(async () => {
      editor?.update(() => {
        $getRoot().select(0, $getRoot().getChildrenSize());
      });
    });

    const data: Record<string, string> = {};
    const clipboardData = {
      setData: vi.fn((type: string, val: string) => {
        data[type] = val;
      }),
      getData: vi.fn((type: string) => data[type] ?? ""),
    };

    await act(async () => {
      fireEvent.copy(el, { clipboardData });
    });

    expect(clipboardData.setData).toHaveBeenCalledWith(
      "application/x-vst-skill-tokens",
      expect.stringContaining('{@file ["src/a.ts","a.ts"]}'),
    );
    expect(clipboardData.setData).toHaveBeenCalledWith(
      "text/plain",
      expect.stringContaining("@src/a.ts"),
    );
  });

  it("paste of application/x-vst-skill-tokens restores a real chip", async () => {
    const { ref } = renderEditor("");
    const el = editorEl();
    const editor = getLexicalEditor(editorEl());

    await act(async () => {
      ref.current?.focus();
      editor?.update(() => {
        $getRoot().select(0, 0);
      });
    });

    const tokenData = 'hello {@file ["src/b.ts","b.ts"]} world';
    const clipboardData = {
      getData: (type: string) => (type === "application/x-vst-skill-tokens" ? tokenData : ""),
    };

    await act(async () => {
      fireEvent.paste(el, { clipboardData });
    });

    expect(screen.getByTitle("src/b.ts")).toBeTruthy();
    expect(ref.current?.getText().trim()).toBe('hello {@file ["src/b.ts","b.ts"]} world');
  });

  it("plain-text paste of @src/a.ts creates no chip", async () => {
    const { ref } = renderEditor("");
    const el = editorEl();

    await act(async () => {
      ref.current?.focus();
    });

    const clipboardData = {
      getData: (type: string) => (type === "text/plain" ? "@src/a.ts" : ""),
    };

    await act(async () => {
      fireEvent.paste(el, { clipboardData });
    });

    expect(screen.queryByTitle("src/a.ts")).toBeNull();
  });
});
