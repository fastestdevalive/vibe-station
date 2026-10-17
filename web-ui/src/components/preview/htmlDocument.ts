import DOMPurify from "dompurify";

export const HTML_FILE_MAX_BYTES = 1_048_576;
export const HTML_CHAT_MAX_BYTES = 262_144;
export const HTML_IFRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

/**
 * Inline `<style>` is allowed (authored CSS renders), but nothing else that
 * can reach the network or run script. Placed FIRST in the srcdoc so user
 * content can never precede or override it.
 */
export const HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";

const HTML_EXTENSIONS = new Set(["html", "htm"]);

/** Whether `path` names an HTML file (by extension, case-insensitive). */
export function isHtmlPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return HTML_EXTENSIONS.has(ext);
}

/** Byte length of a string (UTF-8), for the size caps. */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Private DOMPurify instance so the `afterSanitizeAttributes` hook (link
 * rewriting, Decision 5) never leaks into `MermaidView`'s use of the default
 * instance. Also adds hardened config: whole-document mode, and forbids any
 * tag/attr that could run script or reach the network under the CSP.
 */
const purify = DOMPurify(window);

const FORBID_TAGS = [
  "script",
  "iframe",
  "object",
  "embed",
  "form",
  "meta",
  "link",
  "base",
  "frame",
  "frameset",
];

/** Sanitize untrusted HTML; never throws (DOMPurify tolerates malformed input). */
export function sanitizeHtmlDocument(html: string): string {
  return purify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS,
    FORBID_ATTR: ["srcset"],
    ADD_ATTR: ["target", "rel"],
  });
}

purify.addHook("afterSanitizeAttributes", (node) => {
  const n = node.nodeName.toLowerCase();
  if (n !== "a" && n !== "area") return;
  let kept = false;
  for (const attr of ["href", "xlink:href"]) {
    const value = node.getAttribute(attr)?.trim();
    if (value && /^(https?:|mailto:)/i.test(value)) {
      kept = true;
    } else {
      node.removeAttribute(attr);
    }
  }
  if (kept) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export interface SrcdocOptions {
  colorScheme: "dark" | "light";
  bg?: string;
  fg?: string;
}

/** Only accept plain hex/rgb color tokens — never anything that could inject CSS. */
const COLOR_RE = /^[#a-z0-9(),.\s%-]+$/i;

/**
 * Build the `srcdoc` for the sandboxed iframe. Order is the point: the CSP
 * meta and theme defaults come first, so sanitized user `<style>` can never
 * precede or override them.
 */
export function buildHtmlSrcdoc(html: string, opts: SrcdocOptions): string {
  const bg = opts.bg && COLOR_RE.test(opts.bg) ? opts.bg : undefined;
  const fg = opts.fg && COLOR_RE.test(opts.fg) ? opts.fg : undefined;
  const canvas = bg && fg ? `:where(html,body){background:${bg};color:${fg}}` : "";
  return (
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">` +
    `<style>${canvas}:root{color-scheme:${opts.colorScheme}}</style>` +
    sanitizeHtmlDocument(html)
  );
}
