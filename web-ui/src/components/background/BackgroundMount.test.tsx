import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BackgroundMount } from "./BackgroundMount";

describe("BackgroundMount", () => {
  it("renders nothing outside a router", () => {
    const { container } = render(<BackgroundMount />);
    expect(container).toBeEmptyDOMElement();
  });
});
