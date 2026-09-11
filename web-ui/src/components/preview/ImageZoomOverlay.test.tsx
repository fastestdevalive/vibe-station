import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImageZoomOverlay } from "./ImageZoomOverlay";

describe("ImageZoomOverlay", () => {
  it("renders nothing when src is null", () => {
    const { container } = render(<ImageZoomOverlay src={null} onClose={() => {}} />);
    expect(container.querySelector(".image-zoom-overlay")).toBeNull();
  });

  it("renders the image in a portal when src is set", () => {
    render(<ImageZoomOverlay src="blob:mock" alt="diagram" onClose={() => {}} />);
    const img = document.body.querySelector("img");
    expect(img).toHaveAttribute("src", "blob:mock");
    expect(img).toHaveAttribute("alt", "diagram");
  });

  it("locks body scroll while open and restores on close", () => {
    document.body.style.overflow = "scroll";
    const { rerender } = render(<ImageZoomOverlay src="blob:mock" onClose={() => {}} />);
    expect(document.body.style.overflow).toBe("hidden");
    rerender(<ImageZoomOverlay src={null} onClose={() => {}} />);
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("closes on Escape keydown", () => {
    const onClose = vi.fn();
    render(<ImageZoomOverlay src="blob:mock" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on the close button", () => {
    const onClose = vi.fn();
    render(<ImageZoomOverlay src="blob:mock" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close fullscreen" }));
    expect(onClose).toHaveBeenCalled();
  });
});
