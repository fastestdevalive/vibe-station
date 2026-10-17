import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TextMessage } from "./TextMessage";
import { ThinkingBlock } from "./ThinkingBlock";

/** 7B.10 — a sent user message carries the internal `{/name args}` encoding.
 *  It must never surface a brace, and the skill name must read differently
 *  from its arguments. */
describe("TextMessage — sent skill tokens", () => {
  it("renders a token as a chip with separately styled name and args", () => {
    const { container } = render(
      <TextMessage role="user" text="Can you use {/code-review high --fix} to do this." />,
    );
    const chip = container.querySelector(".chat-msg-skill");
    expect(chip).not.toBeNull();
    expect(chip?.querySelector(".chat-msg-skill__name")?.textContent).toBe("/code-review");
    expect(chip?.querySelector(".chat-msg-skill__args")?.textContent).toBe("high --fix");
    // Prose survives on both sides, and no brace leaks.
    expect(container.textContent).toBe("Can you use /code-review high --fix to do this.");
    expect(container.textContent).not.toContain("{");
  });

  it("renders a token with no args without an empty args span", () => {
    const { container } = render(<TextMessage role="user" text="Also use {/simplify}." />);
    expect(container.querySelector(".chat-msg-skill__name")?.textContent).toBe("/simplify");
    expect(container.querySelector(".chat-msg-skill__args")).toBeNull();
    expect(container.textContent).toBe("Also use /simplify.");
  });

  it("renders TWO tokens mid-sentence, each independently", () => {
    const { container } = render(
      <TextMessage
        role="user"
        text="Use {/code-review high} to do this. Also use {/simplify fast}."
      />,
    );
    const chips = container.querySelectorAll(".chat-msg-skill");
    expect(chips.length).toBe(2);
    expect(chips[0]?.querySelector(".chat-msg-skill__name")?.textContent).toBe("/code-review");
    expect(chips[1]?.querySelector(".chat-msg-skill__args")?.textContent).toBe("fast");
  });

  it("unescapes a literal brace and does NOT treat it as a token", () => {
    const { container } = render(<TextMessage role="user" text={"a \\{ literal brace"} />);
    expect(container.querySelector(".chat-msg-skill")).toBeNull();
    expect(container.textContent).toBe("a { literal brace");
  });

  it("leaves an assistant message to the markdown renderer (no chip styling)", () => {
    const { container } = render(<TextMessage role="assistant" text="Use {/code-review high}." />);
    expect(container.querySelector(".chat-msg-skill")).toBeNull();
  });
});

describe("TextMessage — HTML rendering (4.T3)", () => {
  it("renders an assistant html fence as a sandboxed iframe", () => {
    const { container } = render(
      <TextMessage role="assistant" text={"```html\n<h1>Hi</h1>\n```"} />,
    );
    const iframe = container.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute("srcdoc")).toContain("<h1>Hi</h1>");
  });

  it("renders a thinking block html fence as a code block, never an iframe", () => {
    // ThinkingBlock.tsx:90 omits renderHtml (Decision 9), so even when open a
    // closed html fence stays a plain code block.
    const { container } = render(
      <ThinkingBlock defaultOpen text={"```html\n<h1>Hi</h1>\n```"} startedTs="2024-01-01T00:00:00.000Z" />,
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".workspace-md-code-block")).toBeTruthy();
  });

  it("never reaches StreamingMarkdown for a user message (no iframe)", () => {
    const { container } = render(
      <TextMessage role="user" text={"```html\n<h1>Hi</h1>\n```"} />,
    );
    expect(container.querySelector("iframe")).toBeNull();
  });
});
