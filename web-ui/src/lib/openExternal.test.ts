import { afterEach, describe, expect, it, vi } from "vitest";
import { openExternal } from "./openExternal";

describe("openExternal", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["https://example.com/a", "http://example.com", "mailto:a@b.co"])("opens %s", (url) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openExternal(url);
    expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "vscode://x", "not a url", ""])(
    "rejects %s",
    (url) => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      openExternal(url);
      expect(open).not.toHaveBeenCalled();
    },
  );
});
