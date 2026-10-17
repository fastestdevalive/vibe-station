import { describe, expect, it } from "vitest";
import {
  HTML_CSP,
  buildHtmlSrcdoc,
  isHtmlPath,
  sanitizeHtmlDocument,
} from "./htmlDocument";
import { sanitizeSvg } from "./MermaidView";

describe("isHtmlPath (2.T1)", () => {
  it("recognizes .html and .htm case-insensitively", () => {
    expect(isHtmlPath("a/B.HTML")).toBe(true);
    expect(isHtmlPath("x.htm")).toBe(true);
  });

  it("rejects non-HTML paths", () => {
    expect(isHtmlPath("x.html.txt")).toBe(false);
    expect(isHtmlPath("x")).toBe(false);
    expect(isHtmlPath("x.md")).toBe(false);
  });
});

describe("sanitizeHtmlDocument (2.T2)", () => {
  it("strips script, handlers, iframe, form, meta, link, base, javascript:", () => {
    const out = sanitizeHtmlDocument(
      '<script>alert(1)</script><p onclick="x()" onerror="y()">t</p>' +
        '<iframe src="x"></iframe><form action="/p"></form>' +
        '<meta http-equiv="refresh"><link rel="stylesheet" href="x"><base href="//e.com">' +
        '<a href="javascript:alert(1)">l</a>',
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<form");
    expect(out).not.toContain("<meta");
    expect(out).not.toContain("<link");
    expect(out).not.toContain("<base");
    expect(out).not.toContain("javascript:");
  });
});

describe("link hook (2.T3)", () => {
  it("drops javascript: href", () => {
    const out = sanitizeHtmlDocument('<a href="javascript:x">t</a>');
    expect(out).not.toContain("javascript:");
  });

  it("adds target=_blank + noopener noreferrer to https link", () => {
    const out = sanitizeHtmlDocument('<a href="https://e.com">t</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('href="https://e.com"');
  });

  it("drops #fragment href", () => {
    const out = sanitizeHtmlDocument('<a href="#sec">t</a>');
    expect(out).not.toContain("#sec");
    expect(out).not.toContain('href="');
  });

  it("keeps mailto:", () => {
    const out = sanitizeHtmlDocument('<a href="mailto:a@b.com">t</a>');
    expect(out).toContain('href="mailto:a@b.com"');
  });

  it("removes data:text/html href", () => {
    const out = sanitizeHtmlDocument('<a href="data:text/html,<script>1</script>">t</a>');
    expect(out).not.toContain("data:text/html");
  });

  it("strips href on area and adds target/rel on https area", () => {
    const evil = sanitizeHtmlDocument(
      '<map><area href="javascript:x" shape="rect" coords="0,0,9,9"></map>',
    );
    expect(evil).not.toContain("javascript:");
    expect(evil).not.toContain('href="');

    const good = sanitizeHtmlDocument('<map><area href="https://e.com" shape="rect" coords="0,0,9,9"></map>');
    expect(good).toContain('href="https://e.com"');
    expect(good).toContain('target="_blank"');
    expect(good).toContain('rel="noopener noreferrer"');
  });

  it("strips xlink:href on svg a and adds target/rel on https svg a", () => {
    const evil = sanitizeHtmlDocument(
      '<svg><a xlink:href="javascript:x"><text>t</text></a></svg>',
    );
    expect(evil).not.toContain("javascript:");
    expect(evil).not.toContain("xlink:href");

    const good = sanitizeHtmlDocument('<svg><a href="https://e.com"><text>t</text></a></svg>');
    expect(good).toContain('href="https://e.com"');
    expect(good).toContain('target="_blank"');
    expect(good).toContain('rel="noopener noreferrer"');
  });
});

describe("buildHtmlSrcdoc (2.T4)", () => {
  it("starts with doctype + CSP meta, CSP before user content, no blob:", () => {
    const out = buildHtmlSrcdoc("<p>x</p>", { colorScheme: "dark" });
    expect(out.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    const cspIdx = out.indexOf("Content-Security-Policy");
    const bodyIdx = out.indexOf("<p>x</p>");
    expect(cspIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(cspIdx).toBeLessThan(bodyIdx);
    expect(HTML_CSP).not.toContain("blob:");
  });

  it("uses color-scheme:dark for dark", () => {
    const out = buildHtmlSrcdoc("<p>x</p>", { colorScheme: "dark" });
    expect(out).toContain("color-scheme:dark");
  });

  it("places user style after defaults", () => {
    const out = buildHtmlSrcdoc("<style>body{color:red}</style>", { colorScheme: "dark" });
    const defaultsIdx = out.indexOf(":root{color-scheme");
    const userIdx = out.indexOf("body{color:red}");
    expect(defaultsIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(defaultsIdx);
  });

  it("omits a malicious bg value", () => {
    const out = buildHtmlSrcdoc("<p>x</p>", {
      colorScheme: "dark",
      bg: "red;}</style><script>",
    });
    expect(out).not.toContain("red;}</style>");
    expect(out).not.toContain("<script>");
  });
});

describe("sanitizeSvg regression (2.T5)", () => {
  it("sanitizeSvg does NOT add target=_blank (hook did not leak)", () => {
    const out = sanitizeSvg('<svg><a href="https://e.com"><text>t</text></a></svg>');
    expect(out).not.toContain('target="_blank"');
    expect(out).not.toContain('rel="noopener');
  });
});
