import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactRow } from "./ArtifactRow";
import { makeRow } from "./testFixtures";

type RowProps = Partial<Parameters<typeof ArtifactRow>[0]>;

function renderRow(row: ReturnType<typeof makeRow>, over: RowProps = {}) {
  const { container } = render(
    <ArtifactRow
      row={row}
      selected={false}
      tabbable
      mobile={false}
      menuOpen={false}
      onOpen={vi.fn()}
      onFocusRow={vi.fn()}
      onMenu={vi.fn()}
      setRef={vi.fn()}
      {...over}
    />,
  );
  return container.querySelector<HTMLElement>('[role="option"]')!;
}

describe("ArtifactRow — one line (tools-pane-rework B6.1)", () => {
  it("in-repo row: the text is exactly the name and the short age", () => {
    const row = makeRow({ id: "a", displayPath: "docs/plan.md", inRepo: true, lastWrittenAt: new Date(Date.now() - 2 * 60_000).toISOString() });
    const el = renderRow(row);
    expect(el.querySelector(".artifacts-row__name")).toHaveTextContent("plan.md");
    expect(el.querySelector(".artifacts-row__time")).toHaveTextContent("2m");
    expect(el.textContent).toBe("plan.md2m");
  });

  it("outside-repo, phone and writer-bearing rows show no chip, path, agent or edits", () => {
    const row = makeRow({ id: "b", displayPath: "/Users/x/out/report.html", inRepo: false, editCount: 4, writers: ["s1"] });
    const desktop = renderRow(row, { mobile: false });
    const phone = renderRow(row, { mobile: true });
    for (const el of [desktop, phone]) {
      expect(el.textContent).not.toMatch(/outside repo|edits|\/Users|out\//);
      expect(el.querySelector(".artifacts-row__by, .artifacts-row__path, .artifacts-row__edits, .chip, .artifacts-row__sub")).toBeNull();
    }
    expect(phone).toHaveClass("artifacts-row--mobile");
  });

  it("a missing row is struck through and its age reads 'missing'", () => {
    const row = makeRow({ id: "c", state: "missing", displayPath: "docs/gone.md", inRepo: true });
    const el = renderRow(row);
    expect(el).toHaveClass("artifacts-row--missing");
    expect(el.querySelector(".artifacts-row__time")).toHaveTextContent("missing");
    expect(el.querySelector(".artifacts-row__missing")).not.toBeNull();
  });

  it("a folder hint is rendered muted inside the name, after it", () => {
    const row = makeRow({ id: "d", displayPath: "web-ui/README.md", inRepo: true });
    const el = renderRow(row, { folderHint: "web-ui" });
    const name = el.querySelector(".artifacts-row__name")!;
    expect(name.querySelector(".artifacts-row__hint")).toHaveTextContent("web-ui");
    expect(name.textContent).toBe("README.md web-ui");
  });
});
