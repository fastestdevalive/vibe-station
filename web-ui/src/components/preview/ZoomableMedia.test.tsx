import { render, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZoomableMedia } from "./ZoomableMedia";

function getImgTransform(container: HTMLElement): string {
  const img = container.querySelector("img");
  return (img as HTMLElement).style.transform;
}

describe("ZoomableMedia", () => {
  it("renders an <img> with the given src", () => {
    render(<ZoomableMedia src="blob:mock" alt="diagram" />);
    const img = screen.getByRole("img") as HTMLImageElement;
    expect(img).toHaveAttribute("src", "blob:mock");
    expect(img).toHaveAttribute("alt", "diagram");
  });

  it("zooms in on wheel-up", () => {
    const { container } = render(<ZoomableMedia src="blob:mock" />);
    fireEvent.wheel(container.firstElementChild as HTMLElement, { deltaY: -100, clientX: 100, clientY: 100 });
    // scale > 1 after zoom-in
    expect(getImgTransform(container)).toContain("scale(1.15)");
  });

  it("zooms out on wheel-down", () => {
    const { container } = render(<ZoomableMedia src="blob:mock" />);
    fireEvent.wheel(container.firstElementChild as HTMLElement, { deltaY: 100, clientX: 100, clientY: 100 });
    expect(getImgTransform(container)).toContain("scale(1)");
  });

  it("pans via pointer drag", () => {
    const { container } = render(<ZoomableMedia src="blob:mock" />);
    const el = container.firstElementChild as HTMLElement;
    // Pan applies translate at any scale; no need to pre-zoom.
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 80, clientY: 70 });
    fireEvent.pointerUp(el, { pointerId: 1 });
    expect(getImgTransform(container)).toContain("translate(30px, 20px)");
  });

  it("resets the transform when src changes", () => {
    const { container, rerender } = render(<ZoomableMedia src="blob:one" />);
    const el = container.firstElementChild as HTMLElement;
    fireEvent.wheel(el, { deltaY: -100, clientX: 100, clientY: 100 });
    expect(getImgTransform(container)).toContain("scale(1.15)");
    rerender(<ZoomableMedia src="blob:two" />);
    expect(getImgTransform(container)).toContain("scale(1)");
  });

  it("calls onOpenFullscreen on single tap (inline mode)", () => {
    const spy = vi.fn();
    const { container } = render(<ZoomableMedia src="blob:mock" onOpenFullscreen={spy} />);
    const el = container.firstElementChild as HTMLElement;
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 50, clientY: 50 });
    expect(spy).toHaveBeenCalled();
  });

  it("does not call onOpenFullscreen when the pointer travels >5 px (inline mode)", () => {
    const spy = vi.fn();
    const { container } = render(<ZoomableMedia src="blob:mock" onOpenFullscreen={spy} />);
    const el = container.firstElementChild as HTMLElement;
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("calls onTap on single tap (fullscreen mode)", () => {
    const spy = vi.fn();
    const { container } = render(<ZoomableMedia src="blob:mock" fullscreen onTap={spy} />);
    const el = container.firstElementChild as HTMLElement;
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 50, clientY: 50 });
    expect(spy).toHaveBeenCalled();
  });

  it("does not call onTap when the pointer travels >5 px (fullscreen mode)", () => {
    const spy = vi.fn();
    const { container } = render(<ZoomableMedia src="blob:mock" fullscreen onTap={spy} />);
    const el = container.firstElementChild as HTMLElement;
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not call onOpenFullscreen on tap in fullscreen mode", () => {
    const spy = vi.fn();
    const { container } = render(<ZoomableMedia src="blob:mock" fullscreen onOpenFullscreen={spy} />);
    const el = container.firstElementChild as HTMLElement;
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 50, clientY: 50 });
    expect(spy).not.toHaveBeenCalled();
  });
});
