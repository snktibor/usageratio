import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertsDraft } from "@/components/settings/draft";
import { AlertsSection } from "@/components/settings/sections/alerts-section";
import { renderWithIntl } from "../helpers/render";

/** The "send test" button's answers: a 429 names the wait, from the server's Retry-After. */

const ALERTS: AlertsDraft = {
  webhookUrl: "https://hooks.example.com/x",
  storedMask: null,
  thresholds: [80],
  newThreshold: "",
  perProvider: false,
  format: "slack",
  locale: "en",
};

function sendTest(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
  renderWithIntl(<AlertsSection titleId="alerts" alerts={ALERTS} useTokenLimits={false} onPatch={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Send test" }));
}

const tooMany = (headers: Record<string, string>) =>
  new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers });

describe("AlertsSection test message", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says how long to wait when the server rate limits the test", async () => {
    sendTest(tooMany({ "Retry-After": "7" }));
    expect(await screen.findByText("Too many test messages. Try again in 7 seconds.")).toBeTruthy();
  });

  it("falls back to the test's own 10-second window without a usable Retry-After", async () => {
    sendTest(tooMany({}));
    expect(await screen.findByText("Too many test messages. Try again in 10 seconds.")).toBeTruthy();
  });

  it("keeps the generic failure for any other refusal", async () => {
    sendTest(new Response(JSON.stringify({ error: "webhook_failed" }), { status: 502 }));
    expect(await screen.findByText("Could not send the test message. Check the URL and try again.")).toBeTruthy();
  });
});
