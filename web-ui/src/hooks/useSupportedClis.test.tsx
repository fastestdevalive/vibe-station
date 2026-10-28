import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import type { ApiInstance } from "@/api";
import { useSupportedClis } from "./useSupportedClis";

function Probe({ api, id }: { api: ApiInstance; id: string }) {
  const { clis, failed } = useSupportedClis(api, true);
  return <div data-testid={id}>{failed ? "failed" : clis ? `n=${clis.length}` : "loading"}</div>;
}

describe("useSupportedClis (L4-07)", () => {
  it("two mounted consumers share one getSupportedClis request", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "getSupportedClis");
    render(
      <>
        <Probe api={api} id="a" />
        <Probe api={api} id="b" />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("a").textContent).toMatch(/^n=\d+$/));
    expect(screen.getByTestId("b").textContent).toMatch(/^n=\d+$/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a failure is reported and forgotten, so the next mount retries", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "getSupportedClis").mockRejectedValueOnce(new Error("down"));
    const first = render(<Probe api={api} id="a" />);
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("failed"));
    first.unmount();
    render(<Probe api={api} id="b" />);
    await waitFor(() => expect(screen.getByTestId("b").textContent).toMatch(/^n=\d+$/));
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
