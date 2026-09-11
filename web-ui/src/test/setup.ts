import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

HTMLCanvasElement.prototype.getContext = function getContext() {
  return null;
};

// jsdom doesn't implement scrollIntoView; the chat MessageList calls it on new
// messages. Provide a no-op so those renders don't throw.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// jsdom has no PointerEvent, so testing-library's fireEvent.pointer* falls back
// to a bare event that drops clientX/clientY (and pointerId). Polyfill a minimal
// PointerEvent over MouseEvent so pointer-based components (ZoomableMedia's
// drag/pinch) are testable with real coordinates.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, params: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "mouse";
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    writable: true,
    configurable: true,
    value: PointerEventPolyfill,
  });
}

// jsdom doesn't implement URL.createObjectURL/revokeObjectURL, which the image
// renderers (MarkdownImage, FilePreviewPane, MermaidView) use to display blobs.
// Polyfill with incrementing fake blob: URLs so image tests can assert rendering.
if (typeof URL.createObjectURL === "undefined") {
  let blobCounter = 0;
  URL.createObjectURL = function createObjectURL() {
    return `blob:mock-${blobCounter++}`;
  };
  URL.revokeObjectURL = function revokeObjectURL() {
    /* no-op — fake blob URLs need no cleanup */
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--font-family");
});
