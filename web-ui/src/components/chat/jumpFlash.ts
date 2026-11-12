/** How long a jumped-to row keeps its tint, and how long the tint then fades. */
export const JUMP_FLASH_MS = 2000;
export const JUMP_FLASH_FADE_MS = 600;
/** The attribute the tint hangs on (`outline.css`): "on" while lit, "out" while fading. */
export const JUMP_FLASH_ATTR = "data-jump-flash";

export interface JumpFlash {
  /** Tints `el`; a running flash on another row ends at once. */
  flash(el: HTMLElement): void;
  /** Ends the running flash now (unmount, or a newer jump). */
  clear(): void;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** One flash at a time: a row lit after a jump, faded out after JUMP_FLASH_MS (removed outright under reduced motion). */
export function createJumpFlash(): JumpFlash {
  let current: HTMLElement | null = null;
  let timers: ReturnType<typeof setTimeout>[] = [];

  const clear = () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
    current?.removeAttribute(JUMP_FLASH_ATTR);
    current = null;
  };

  const flash = (el: HTMLElement) => {
    clear();
    current = el;
    el.setAttribute(JUMP_FLASH_ATTR, "on");
    timers.push(
      setTimeout(() => {
        if (prefersReducedMotion()) {
          clear();
          return;
        }
        el.setAttribute(JUMP_FLASH_ATTR, "out");
        timers.push(setTimeout(clear, JUMP_FLASH_FADE_MS));
      }, JUMP_FLASH_MS),
    );
  };

  return { flash, clear };
}
