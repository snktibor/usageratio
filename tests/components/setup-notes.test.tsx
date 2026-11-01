import { describe, expect, it } from "vitest";
import { SetupNotes } from "@/components/setup/setup-notes";
import { INSTALLED_CONFIG } from "@/lib/setup";
import { renderWithIntl } from "../helpers/render";

describe("SetupNotes", () => {
  it("renders the tags of its messages: the code, and the Windows config path whole", () => {
    const { container } = renderWithIntl(<SetupNotes os="windows" mode="auto" notesId="notes" />);
    const code = [...container.querySelectorAll("code")].map((element) => element.textContent);

    expect(code).toContain("node --version");
    expect(code).toContain(INSTALLED_CONFIG.windows);
  });
});
