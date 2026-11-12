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

  describe("inline folder suggestion ghost", () => {
    const entries = [{ name: "projects", path: "/mock/projects" }];
    function setup(fsComplete: () => Promise<unknown>) {
      const api = createMockApi();
      vi.spyOn(api, "fsComplete").mockImplementation(fsComplete as never);
      render(
        <OobeStep1Location api={api} defaultProjectsDir="" vstHome="" onConfirmed={vi.fn()} />,
      );
      return screen.getByLabelText("Default projects directory") as HTMLInputElement;
    }
    const ok = async () => ({ base: "/mock/", entries, truncated: false });

    it("shows a directory ghost for a completion, none for a trailing slash, and Tab accepts", async () => {
      const input = setup(ok);
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "/mock/pro" } });
      await waitFor(() => expect(document.querySelector(".path-ghost")?.textContent).toBe("/mock/projects/"));
      expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
      expect(input.value).toBe("/mock/projects/");
      expect(document.querySelector(".path-ghost")).toBeNull();
    });

    it("ArrowRight at the caret end accepts", async () => {
      const input = setup(ok);
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "/mock/pro" } });
      await waitFor(() => expect(document.querySelector(".path-ghost")).not.toBeNull());
      input.setSelectionRange(9, 9);
      expect(fireEvent.keyDown(input, { key: "ArrowRight" })).toBe(false);
      expect(input.value).toBe("/mock/projects/");
    });

    it("no ghost when nothing completes; a failed fetch shows a muted note", async () => {
      const input = setup(async () => {
        throw new Error("boom");
      });
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "/mock/pro" } });
      expect(await screen.findByTestId("oobe-step1-suggest-error")).toHaveClass("path-ghost-note");
      expect(document.querySelector(".path-ghost")).toBeNull();
    });
  });
});
