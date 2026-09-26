import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusLine } from "@/components/status-line";
import { renderWithIntl } from "../helpers/render";

describe("StatusLine", () => {
  it("renders the sentence next to an icon that is hidden from screen readers", () => {
    const { container } = renderWithIntl(<StatusLine tone="problem">Something went wrong.</StatusLine>);
    expect(screen.getByText("Something went wrong.")).toBeTruthy();
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("tells the tone through the icon, not through colour alone", () => {
    const { container: good } = renderWithIntl(<StatusLine tone="good">Saved.</StatusLine>);
    const { container: info } = renderWithIntl(<StatusLine tone="neutral">Note.</StatusLine>);
    expect(good.querySelector("svg")?.outerHTML).not.toEqual(info.querySelector("svg")?.outerHTML);
  });
});
