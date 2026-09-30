import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createMockApi, type MockApi } from "@/api/mock";
import { ModelPicker } from "./ModelPicker";

describe("ModelPicker", () => {
  it("shows the daemon's error text when the model list can't be fetched", async () => {
    const api = createMockApi() as MockApi;
    vi.spyOn(api, "listCliModels").mockResolvedValue({ models: [], error: "Claude is not logged in" });
    render(<ModelPicker api={api} cli="claude" value={undefined} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Claude is not logged in")).toBeTruthy());
  });

  it("shows an error (not an endless loading state) when the request itself rejects", async () => {
    const api = createMockApi() as MockApi;
    vi.spyOn(api, "listCliModels").mockRejectedValue(new Error("network down"));
    render(<ModelPicker api={api} cli="claude" value={undefined} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("network down")).toBeTruthy());
  });

  it("doesn't duplicate the picker's own (default) option for a literal 'default' id", async () => {
    const api = createMockApi() as MockApi;
    vi.spyOn(api, "listCliModels").mockResolvedValue({ models: ["default", "opus"] });
    render(<ModelPicker api={api} cli="claude" value={undefined} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "opus" })).toBeTruthy());
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["(default)", "opus"]);
  });
});
