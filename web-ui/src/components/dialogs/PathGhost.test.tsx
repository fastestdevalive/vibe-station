import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PathGhost } from "./PathGhost";

describe("PathGhost", () => {
  it("renders a hidden typed mirror plus the remainder, aria-hidden", () => {
    const { container } = render(<PathGhost getInput={() => null} typed="/home/u/.cl" remainder="aude" />);
    const ghost = container.querySelector(".path-ghost");
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".path-ghost__typed")?.textContent).toBe("/home/u/.cl");
    expect(ghost?.textContent).toBe("/home/u/.claude");
  });

  it("follows the input's scroll", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const { container } = render(<PathGhost getInput={() => input} typed="/a" remainder="b" />);
    const track = container.querySelector<HTMLElement>(".path-ghost__track")!;
    expect(track.style.transform).toBe("translateX(0px)");
    input.scrollLeft = 40;
    act(() => {
      fireEvent.scroll(input);
    });
    expect(track.style.transform).toBe("translateX(-40px)");
    input.remove();
  });

  it("hides the remainder and reports clipped when it overflows the box", () => {
    const sw = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
    const cw = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200);
    const onClippedChange = vi.fn();
    const { container } = render(
      <PathGhost getInput={() => null} typed="/a" remainder="b" onClippedChange={onClippedChange} />,
    );
    expect(onClippedChange).toHaveBeenLastCalledWith(true);
    expect(container.querySelector<HTMLElement>(".path-ghost__track")!.style.visibility).toBe("hidden");
    sw.mockRestore();
    cw.mockRestore();
  });
});
