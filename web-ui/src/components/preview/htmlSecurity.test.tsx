import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HTML_IFRAME_SANDBOX, buildHtmlSrcdoc, sanitizeHtmlDocument } from "./htmlDocument";
import { HtmlView } from "./HtmlView";

/**
 * Adversarial corpus (5.T1). Assert on the SANITIZED output, not the full
 * srcdoc (whose CSP meta legitimately contains `content=`), so these checks
 * stay targeted at the sanitizer, not the CSP string.
 */
const PAYLOADS: Array<[string, string]> = [
  ["img onerror", "<img src=x onerror=alert(1)>"],
  ["svg onload", "<svg onload=alert(1)>"],
  ["a javascript with leading space", '<a href=" javascript:alert(1)">t</a>'],
  ["area javascript", '<area href="javascript:alert(1)">'],
  ["svg a xlink javascript", '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'],
  ["meta refresh", '<meta http-equiv=refresh content="0;url=//e.com">'],
  ["base", '<base href="//e.com/">'],
  ["iframe srcdoc", '<iframe srcdoc="<script>1</script>">'],
  ["closing-style script", "</style><script>x</script>"],
  ["math mtext table mglyph mXSS", "<math><mtext><table><mglyph><style><img src onerror=x>"],
];

const ON_EVENT_RE = /\son[a-z]+\s*=/i;

describe("htmlSecurity adversarial corpus (5.T1)", () => {
  it.each(PAYLOADS)("neutralizes %s", (_name, payload) => {
    const out = sanitizeHtmlDocument(payload);
    expect(out).not.toContain("<script");
    expect(out).not.toMatch(ON_EVENT_RE);
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("http-equiv");
    expect(out).not.toContain("<base");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<object");
    expect(out).not.toContain("<embed");
    expect(out).not.toContain("<form");
  });

  it("puts the CSP meta before a user @import style in the srcdoc", () => {
    const srcdoc = buildHtmlSrcdoc("<style>@import url(//e.com/x.css)</style>", {
      colorScheme: "dark",
    });
    const cspIdx = srcdoc.indexOf("Content-Security-Policy");
    const importIdx = srcdoc.indexOf("@import");
    expect(cspIdx).toBeGreaterThan(-1);
    expect(importIdx).toBeGreaterThan(-1);
    expect(cspIdx).toBeLessThan(importIdx);
  });

  it("every rendered HtmlView iframe sandbox equals HTML_IFRAME_SANDBOX", () => {
    const { container } = render(<HtmlView source="<p>hi</p>" variant="file" />);
    const frame = container.querySelector("iframe")!;
    expect(frame).toBeTruthy();
    expect(frame.getAttribute("sandbox")).toBe(HTML_IFRAME_SANDBOX);
  });
});
