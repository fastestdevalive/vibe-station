import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TextMessage } from "./TextMessage";

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
