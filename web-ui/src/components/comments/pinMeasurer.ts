import { cssEscape } from "./commentJump";
import {
  groupPins,
  isCoarsePointer,
  measurePin,
  mergeDistance,
  pinSize,
  samePlacements,
  type PinPlacement,
} from "./pinGeometry";

/** What a host asks the measurer to place. `endCol` undefined = markdown: find the end marker in the host. */
export interface PinTarget {
  id: string;
  pin: number;
  outdated?: boolean;
  draft?: boolean;
  active?: boolean;
  /** Accessible name of the pin button (`pinLabel`). */
  label?: string;
  /** Row text column the commented selection ends at; null = end of the row's text (blank / outdated row). */
  endCol?: number | null;
}

export interface PinHostSpec {
  host: HTMLElement;
  /** Element whose text the end column indexes (re-read every measure: rows re-create it). `null` = the host itself. */
  textEl: () => HTMLElement | null;
  /** The pins to place (latest value). */
  targets: () => readonly PinTarget[];
  /** Receives the new placements (React setState); only called when they changed. */
  apply: (placements: PinPlacement[]) => void;
}

export interface PinHostHandle {
  markDirty: () => void;
  unregister: () => void;
}

interface Entry extends PinHostSpec {
  dirty: boolean;
  visible: boolean;
  observedText: Element | null;
  last: PinPlacement[];
}

const esc = cssEscape;

/** Marker element a markdown pin hangs off: the comment's last mark, else the block that held its last line. */
function markerEnd(host: HTMLElement, id: string): Element | null {
  const mark = host.querySelector(`mark[data-comment-end][data-comment-id="${esc(id)}"]`);
  if (mark) return mark;
  return [...host.querySelectorAll("[data-comment-fallback]")].find((el) => (el.getAttribute("data-comment-fallback") ?? "").split(" ").includes(id)) ?? null;
}

/**
 * Places comment pins on the visual line of the last character of each commented selection. One per comment
 * surface (held in the surface context). Hosts (a code / diff row, the markdown container) register on mount;
 * everything that can move a wrap marks them dirty (resize of the text box, web-font load, theme change,
 * content change), and ONE `requestAnimationFrame` per burst runs the read phase for every dirty visible host
 * (all rects, no writes) and then the write phase (placements to React, the code view's horizontal offset).
 */
export class PinMeasurer {
  private entries = new Map<HTMLElement, Entry>();
  private byEl = new Map<Element, Entry>();
  private stacks = new Set<HTMLElement>();
  private root: HTMLElement | null = null;
  private raf = 0;
  private xDirty = false;
  private lastX: { left: number; width: number } | null = null;
  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;
  private mo: MutationObserver | null = null;
  private onFonts = () => this.markAllDirty();
  private onScroll = () => this.scheduleX();
  private detachFns: Array<() => void> = [];

  /** Bind to the scroll element (`.preview-body`). Observers are only created once a host or stack exists. */
  attach(root: HTMLElement | null): void {
    if (root === this.root) return;
    this.detach();
    this.root = root;
    this.ensureObservers();
  }

  private observing = false;

  /** Create the observers on first use: a surface without comments holds none of them. */
  private ensureObservers(): void {
    const root = this.root;
    if (!root || this.observing || (this.entries.size === 0 && this.stacks.size === 0)) return;
    this.observing = true;
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver((records) => {
        for (const r of records ?? []) {
          if (r.target === root) this.scheduleX();
          const e = this.byEl.get(r.target);
          if (e) this.dirty(e);
        }
      });
      this.ro.observe(root);
      for (const e of this.entries.values()) this.observe(e);
    }
    if (typeof IntersectionObserver !== "undefined") {
      this.io = new IntersectionObserver(
        (records) => {
          for (const r of records) {
            const e = this.byEl.get(r.target);
            if (!e) continue;
            e.visible = r.isIntersecting;
            if (e.visible && e.dirty) this.schedule();
          }
        },
        { root, rootMargin: "200px 0px" },
      );
      for (const e of this.entries.values()) {
        e.visible = false;
        this.io.observe(e.host);
      }
    }
    root.addEventListener("scroll", this.onScroll, { passive: true });
    this.detachFns.push(() => root.removeEventListener("scroll", this.onScroll));
    if (typeof document !== "undefined") {
      document.fonts?.addEventListener?.("loadingdone", this.onFonts);
      this.detachFns.push(() => document.fonts?.removeEventListener?.("loadingdone", this.onFonts));
      if (typeof MutationObserver !== "undefined") {
        this.mo = new MutationObserver(() => this.markAllDirty());
        this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-appearance"] });
      }
    }
    this.markAllDirty();
    this.scheduleX();
  }

  detach(): void {
    this.ro?.disconnect();
    this.io?.disconnect();
    this.mo?.disconnect();
    this.ro = this.io = this.mo = null;
    for (const f of this.detachFns) f();
    this.detachFns = [];
    if (this.raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.root = null;
    this.lastX = null;
    this.observing = false;
  }

  register(spec: PinHostSpec): PinHostHandle {
    const entry: Entry = { ...spec, dirty: true, visible: !this.io, observedText: null, last: [] };
    this.entries.set(spec.host, entry);
    this.byEl.set(spec.host, entry);
    this.ensureObservers();
    this.observe(entry);
    this.io?.observe(spec.host);
    this.schedule();
    return {
      markDirty: () => this.dirty(entry),
      unregister: () => {
        this.entries.delete(spec.host);
        this.byEl.delete(spec.host);
        if (entry.observedText) this.byEl.delete(entry.observedText);
        this.ro?.unobserve(spec.host);
        if (entry.observedText) this.ro?.unobserve(entry.observedText);
        this.io?.unobserve(spec.host);
      },
    };
  }

  /** A pin stack of the code view: its horizontal offset follows the scroll position (`--x`). */
  trackStack(el: HTMLElement): () => void {
    this.stacks.add(el);
    this.ensureObservers();
    this.xDirty = true;
    this.schedule();
    return () => {
      this.stacks.delete(el);
    };
  }

  get hostCount(): number {
    return this.entries.size;
  }

  markAllDirty(): void {
    for (const e of this.entries.values()) e.dirty = true;
    this.schedule();
  }

  private observe(e: Entry): void {
    if (!this.ro) return;
    this.ro.observe(e.host);
    const t = e.textEl();
    if (t !== e.observedText) {
      if (e.observedText) {
        this.ro.unobserve(e.observedText);
        this.byEl.delete(e.observedText);
      }
      e.observedText = t && t !== e.host ? t : null;
      if (e.observedText) {
        this.byEl.set(e.observedText, e);
        this.ro.observe(e.observedText);
      }
    }
  }

  private dirty(e: Entry): void {
    e.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.raf || typeof requestAnimationFrame !== "function") return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.flush();
    });
  }

  /** The horizontal offset only depends on `scrollLeft` and `clientWidth`: skip when neither moved. */
  private scheduleX(): void {
    const r = this.root;
    if (r && this.lastX && this.lastX.left === r.scrollLeft && this.lastX.width === r.clientWidth) return;
    this.xDirty = true;
    this.schedule();
  }

  /** One frame of work: every read first, then every write. Exposed for tests. */
  flush(): void {
    const coarse = isCoarsePointer();
    const pin = pinSize(coarse);
    const distance = mergeDistance(coarse);

    // ── read phase ──
    const results: Array<{ e: Entry; placements: PinPlacement[] }> = [];
    for (const e of this.entries.values()) {
      if (!e.dirty || !e.visible) continue;
      e.dirty = false;
      const targets = e.targets();
      const text = e.textEl() ?? e.host;
      const items: Array<{ id: string; pin: number; top: number }> = [];
      for (const t of targets) {
        let top: number | null;
        if (t.endCol === undefined) {
          const end = markerEnd(e.host, t.id);
          top = end ? measurePin(e.host, text, null, pin, end) : null;
        } else {
          top = measurePin(e.host, text, t.endCol, pin);
        }
        if (top != null) items.push({ id: t.id, pin: t.pin, top });
      }
      results.push({ e, placements: groupPins(items, distance) });
    }
    const x = this.readX();

    // ── write phase ──
    for (const { e, placements } of results) {
      if (samePlacements(e.last, placements)) continue;
      e.last = placements;
      e.apply(placements);
    }
    for (const e of this.entries.values()) this.observe(e);
    if (x) this.writeX(x);
  }

  private readX(): { left: number; width: number; gutter: number; sizes: Array<[HTMLElement, number]> } | null {
    const root = this.root;
    if (!root || this.stacks.size === 0 || !this.xDirty) return null;
    this.xDirty = false;
    const left = root.scrollLeft;
    const width = root.clientWidth;
    const gutter = parseFloat(getComputedStyle(root).getPropertyValue("--comment-gutter-w")) || 24;
    this.lastX = { left, width };
    return { left, width, gutter, sizes: [...this.stacks].map((el) => [el, el.offsetWidth] as [HTMLElement, number]) };
  }

  private writeX(x: { left: number; width: number; gutter: number; sizes: Array<[HTMLElement, number]> }): void {
    for (const [el, w] of x.sizes) {
      const stackW = w || pinSize(isCoarsePointer());
      el.style.setProperty("--x", `${x.left + x.width - x.gutter + (x.gutter - stackW) / 2}px`);
    }
  }
}
