import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { createMockApi } from "@/api/mock";
import { AboutSetting } from "./AboutSetting";
import { THIRD_PARTY_LICENSES } from "./thirdPartyLicenses";

describe("AboutSetting", () => {
  it("renders all third-party license rows with links that open in a new tab with rel=noreferrer", async () => {
    render(<AboutSetting api={createMockApi()} />);

    // Let the async health() fetch that populates the version settle, so its
    // state update happens inside act rather than after the assertions.
    await screen.findByText(/0\.0\.0-mock/i);

    expect(screen.getByText(/third-party licenses/i)).toBeInTheDocument();

    for (const item of THIRD_PARTY_LICENSES) {
      expect(screen.getByText(item.name)).toBeInTheDocument();
      const link = screen
        .getAllByRole("link")
        .find((el) => el.getAttribute("href") === item.url);
      expect(link).not.toBeUndefined();
      expect(link).toHaveTextContent(item.license);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer");
    }

    expect(screen.getAllByRole("link")).toHaveLength(THIRD_PARTY_LICENSES.length + 1);
  });
});
