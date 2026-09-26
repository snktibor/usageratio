import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinForm } from "@/components/pin-form";
import { renderWithIntl } from "../helpers/render";

/**
 * A numeric PIN gets a numeric keypad and digit filtering, never a length
 * hint via auto-submit unless the owner opted in; a passphrase gets a plain
 * field with a show/hide toggle. The error text comes from the server
 * action's result code, translated.
 */

vi.mock("@/app/actions", () => ({
  login: vi.fn(async (_previous: unknown, formData: FormData) => {
    const pin = String(formData.get("pin") ?? "");
    return pin === "12345" ? { error: null } : { error: { code: "invalid", attemptsLeft: 3 } };
  }),
}));

function pinInput(): HTMLInputElement {
  const input = document.getElementById("pin");
  if (!(input instanceof HTMLInputElement)) throw new Error("no #pin input rendered");
  return input;
}

describe("PinForm", () => {
  afterEach(() => vi.restoreAllMocks());

  it("numeric: a password field with a numeric keypad, digits only, no show/hide toggle", () => {
    renderWithIntl(<PinForm labelledBy="pin-heading" next="/" numeric={true} />);
    const input = pinInput();
    expect(input.type).toBe("password");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(screen.queryByRole("button", { name: "Show" })).toBeNull();

    fireEvent.change(input, { target: { value: "1a2b3c4d5e" } });
    expect(input.value).toBe("12345");
  });

  it("passphrase: a plain password field with a show/hide toggle, no digit filtering", () => {
    renderWithIntl(<PinForm labelledBy="pin-heading" next="/" numeric={false} />);
    const input = pinInput();
    expect(input.type).toBe("password");
    expect(input.getAttribute("inputmode")).toBeNull();
    expect(input.autocomplete).toBe("current-password");

    fireEvent.change(input, { target: { value: "correct horse 1" } });
    expect(input.value).toBe("correct horse 1");

    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(input.type).toBe("text");
    expect(screen.getByRole("button", { name: "Hide" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(input.type).toBe("password");
  });

  it("never auto-submits on its own, even once the field reaches a plausible PIN length", () => {
    const submitSpy = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => {});
    renderWithIntl(<PinForm labelledBy="pin-heading" next="/" numeric={true} />);
    fireEvent.change(pinInput(), { target: { value: "12345" } });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("auto-submits at the configured length only when the owner opted in with autoSubmitLength", () => {
    const submitSpy = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => {});
    renderWithIntl(<PinForm labelledBy="pin-heading" next="/" numeric={true} autoSubmitLength={5} />);
    const input = pinInput();

    fireEvent.change(input, { target: { value: "1234" } });
    expect(submitSpy).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "12345" } });
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("shows the error text the server action's result code maps to", async () => {
    renderWithIntl(<PinForm labelledBy="pin-heading" next="/" numeric={true} />);
    fireEvent.change(pinInput(), { target: { value: "00000" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    await screen.findByText("Incorrect PIN. 3 attempts left.");
  });
});
