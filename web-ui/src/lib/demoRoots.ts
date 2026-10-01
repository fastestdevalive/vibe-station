/**
 * Leaf module (no imports) holding the two DOM roots the app writes to. Outside website demos both are
 * unset and every write goes to `<html>` / `document.head` exactly as before; an inline demo points them
 * at its own container so the host page is never touched (inline-demos Decision 8).
 */
let themeRoot: HTMLElement | null = null;
let styleHost: HTMLElement | null = null;

/** Where `useThemeStore` writes `data-theme`, `data-appearance` and `--font-family` (null = `<html>`). */
export function setThemeRoot(el: HTMLElement | null): void {
  themeRoot = el;
}

export function getThemeRoot(): HTMLElement {
  return themeRoot ?? document.documentElement;
}

/** Where the injected markdown `<style>` lives (null = `document.head`). */
export function setStyleHost(el: HTMLElement | null): void {
  styleHost = el;
}

export function getStyleHost(): HTMLElement {
  return styleHost ?? document.head;
}
