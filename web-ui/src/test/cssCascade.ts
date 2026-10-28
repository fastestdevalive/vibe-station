/**
 * Test-only: reads real stylesheet text through jsdom's CSSOM and resolves a selector's declarations the way the
 * browser would for the properties we assert on (last declaration wins, `@media` blocks gated by `phone`, custom
 * properties via `var()` incl. fallbacks, and px `calc()`), so layout CSS contracts are asserted on RESULTING
 * values instead of source text. jsdom has no layout engine: geometry is checked in the Playwright measure scripts under `.vibekit/reports/`.
 */
export interface Cascade {
  /** Declarations that apply to the compound selector `selector` (exact match inside a selector list). */
  decls(selector: string, opts?: { phone?: boolean; vars?: Record<string, string> }): Record<string, string>;
  /** Resolved px value of `prop` for `selector` (var()/calc() evaluated), or null when unset / not numeric. */
  px(selector: string, prop: string, opts?: { phone?: boolean }): number | null;
  /** Value of a custom property declared on `selector` (resolved to px when numeric). */
  varPx(selector: string, name: string): number | null;
  /** Every selector (comma-split, trimmed) of every style rule, for "no rule targets class X" checks. */
  selectors(): string[];
}

/** Splits on whitespace outside parentheses (so `var(--a, var(--b))` stays one token). */
function splitTopLevel(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export function loadCascade(cssText: string | string[]): Cascade {
  const texts = Array.isArray(cssText) ? cssText : [cssText];
  const sheets = texts.map((t) => {
    const style = document.createElement("style");
    style.textContent = t;
    document.head.appendChild(style);
    return style.sheet as CSSStyleSheet;
  });

  const walk = (rules: CSSRuleList, phone: boolean, out: { sel: string; style: CSSStyleDeclaration }[]) => {
    for (const rule of Array.from(rules)) {
      const r = rule as CSSRule & { selectorText?: string; conditionText?: string; media?: { mediaText: string }; cssRules?: CSSRuleList };
      if (r.selectorText != null) {
        for (const part of r.selectorText.split(",")) out.push({ sel: norm(part), style: (r as unknown as CSSStyleRule).style });
      } else if (r.cssRules) {
        const cond = norm(r.conditionText ?? r.media?.mediaText ?? "");
        if (cond === "(max-width: 768px)") {
          if (phone) walk(r.cssRules, phone, out);
        } else if (cond === "(min-width: 769px)") {
          if (!phone) walk(r.cssRules, phone, out);
        }
        // @container and other at-rules are intentionally not evaluated.
      }
    }
  };

  const flat = (phone: boolean) => {
    const out: { sel: string; style: CSSStyleDeclaration }[] = [];
    for (const sh of sheets) walk(sh.cssRules, phone, out);
    return out;
  };

  const declsOf = (selector: string, phone: boolean) => {
    const res: Record<string, string> = {};
    for (const { sel, style } of flat(phone)) {
      if (sel !== norm(selector)) continue;
      for (let i = 0; i < style.length; i++) {
        const name = (style as unknown as string[])[i]!;
        const val = style.getPropertyValue(name).trim();
        if (name === "padding") {
          // Expand the shorthand (1-4 values) so longhand reads and later overrides compose like the browser.
          const p = splitTopLevel(val);
          const [t, r = t, b = t, l = r] = p;
          Object.assign(res, { "padding-top": t, "padding-right": r, "padding-bottom": b, "padding-left": l });
        } else res[name] = val;
      }
    }
    return res;
  };

  /** Custom properties visible to everything under `.app-shell`: `:root` tokens, then `.app-shell` (all layout rules live inside it). */
  const rootVars = (phone: boolean) => {
    const v: Record<string, string> = {};
    for (const sel of [":root", ".app-shell"]) {
      for (const [k, val] of Object.entries(declsOf(sel, phone))) if (k.startsWith("--")) v[k] = val;
    }
    return v;
  };

  const subst = (value: string, vars: Record<string, string>, depth = 0): string => {
    if (depth > 8) return value;
    let out = value;
    const re = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/;
    for (let m = re.exec(out), n = 0; m && n < 50; m = re.exec(out), n++) {
      const rep = vars[m[1]!] ?? m[2] ?? "";
      out = out.slice(0, m.index) + rep + out.slice(m.index + m[0].length);
    }
    return /var\(/.test(out) ? subst(out, vars, depth + 1) : out;
  };

  const evalPx = (expr: string): number | null => {
    const s = expr.replace(/calc/g, "").replace(/(-?\d*\.?\d+)px/g, "$1").trim();
    if (!/^[\d.+\-*/() ]+$/.test(s)) return null;
    let i = 0;
    const peek = () => {
      while (s[i] === " ") i++;
      return s[i];
    };
    const num = (): number => {
      if (peek() === "(") {
        i++;
        const v = add();
        peek();
        i++;
        return v;
      }
      if (peek() === "-") {
        i++;
        return -num();
      }
      const m = /^\d*\.?\d+/.exec(s.slice(i));
      if (!m) throw new Error("bad number");
      i += m[0].length;
      return Number(m[0]);
    };
    const mul = (): number => {
      let v = num();
      for (;;) {
        const c = peek();
        if (c === "*") {
          i++;
          v *= num();
        } else if (c === "/") {
          i++;
          v /= num();
        } else return v;
      }
    };
    const add = (): number => {
      let v = mul();
      for (;;) {
        const c = peek();
        if (c === "+") {
          i++;
          v += mul();
        } else if (c === "-") {
          i++;
          v -= mul();
        } else return v;
      }
    };
    try {
      const v = add();
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };

  return {
    decls: (selector, opts) => declsOf(selector, opts?.phone ?? false),
    px(selector, prop, opts) {
      const phone = opts?.phone ?? false;
      const d = declsOf(selector, phone);
      const own: Record<string, string> = {};
      for (const [k, val] of Object.entries(d)) if (k.startsWith("--")) own[k] = val;
      const raw = d[prop];
      if (raw == null) return null;
      const vars = { ...rootVars(phone), ...own };
      // A custom property may itself hold var()/calc(): resolve it first.
      for (const k of Object.keys(vars)) vars[k] = subst(vars[k]!, vars);
      return evalPx(subst(raw, vars));
    },
    varPx(selector, name) {
      const phone = false;
      const vars = { ...rootVars(phone), ...declsOf(selector, phone) };
      for (const k of Object.keys(vars)) vars[k] = subst(vars[k]!, vars);
      const raw = vars[name];
      return raw == null ? null : evalPx(raw);
    },
    selectors: () => flat(false).concat(flat(true)).map((r) => r.sel),
  };
}
