import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TextMessage } from "./TextMessage";

describe("TextMessage — scheduled tag", () => {
  it("renders the tag INSIDE the user bubble when the message came from a schedule", () => {
    const { container } = render(<TextMessage role="user" text="remind me" scheduled />);
    const tag = container.querySelector(".chat-bubble--user .chat-bubble__scheduled");
    expect(tag).toBeTruthy();
    expect(tag!.textContent).toContain("Scheduled");
  });

  it("is absent for normal user messages and never shown on assistant messages", () => {
    expect(render(<TextMessage role="user" text="hi" />).container.querySelector(".chat-bubble__scheduled")).toBeNull();
    expect(
      render(<TextMessage role="assistant" text="hello" scheduled />).container.querySelector(".chat-bubble__scheduled"),
    ).toBeNull();
  });
});
