import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createMockApi } from "@/api/mock";
import { OobeStep1Location } from "./OobeStep1Location";

describe("OobeStep1Location", () => {
  it("4.T2 — a relative path shows the inline error from the 400 and does NOT call onConfirmed", async () => {
    const api = createMockApi();
    const onConfirmed = vi.fn();
    render(
      <OobeStep1Location api={api} defaultProjectsDir="/mock/projects" vstHome="/mock/home/.vibe-station" onConfirmed={onConfirmed} />,
    );

    fireEvent.change(screen.getByLabelText("Default projects directory"), {
      target: { value: "relative/path" },
    });
    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByTestId("oobe-step1-error")).toHaveTextContent("path must be absolute");
    });
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("4.T2 — a valid absolute path calls onConfirmed with the value from the (successful) response", async () => {
    const api = createMockApi();
    const onConfirmed = vi.fn();
    render(
      <OobeStep1Location api={api} defaultProjectsDir="/mock/projects" vstHome="/mock/home/.vibe-station" onConfirmed={onConfirmed} />,
    );

    fireEvent.change(screen.getByLabelText("Default projects directory"), {
      target: { value: "/home/user/projects" },
    });
    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(onConfirmed).toHaveBeenCalledWith("/home/user/projects");
    });
    expect(screen.queryByTestId("oobe-step1-error")).toBeNull();
  });
});
