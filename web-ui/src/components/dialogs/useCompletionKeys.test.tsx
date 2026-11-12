import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCompletionKeys } from "./useCompletionKeys";

function Probe({ onAccept }: { onAccept: () => void }) {
  const keys = useCompletionKeys({ entries: [], ghostEntry: null, onAccept, onEnter: () => {} });
  return <input aria-label="p" onKeyDown={keys.onKeyDown} />;
}

describe("useCompletionKeys", () => {
  it("Tab with no ghost and no rows is left alone", () => {
    const onAccept = vi.fn();
    render(<Probe onAccept={onAccept} />);
    expect(fireEvent.keyDown(screen.getByLabelText("p"), { key: "Tab" })).toBe(true);
    expect(onAccept).not.toHaveBeenCalled();
  });
});
