import { describe, expect, it } from "vitest";
import { isAllowedWebhookUrl, MAX_WEBHOOK_URL_LENGTH, maskWebhookUrl, webhookFieldProblem } from "@/lib/webhook";

describe("isAllowedWebhookUrl", () => {
  it("accepts the https webhooks of the usual services", () => {
    for (const url of [
      "https://hooks.example.com/services/x",
      "https://discord.com/api/webhooks/123456789012345678/abcDEF-ghi_jkl",
      "https://hooks.slack.com/services/T000/B000/XXXXXXXX",
      "https://ntfy.sh/my-topic",
      "https://Hooks.Example.COM/x",
    ]) {
      expect(isAllowedWebhookUrl(url), url).toBe(true);
    }
  });

  it("rejects anything that is not https", () => {
    for (const url of [
      "http://example.com",
      "ftp://example.com",
      "file:///etc/passwd",
      "gopher://example.com",
      "not a url",
    ]) {
      expect(isAllowedWebhookUrl(url), url).toBe(false);
    }
  });

  it("rejects credentials in the URL", () => {
    expect(isAllowedWebhookUrl("https://user:pass@example.com")).toBe(false);
    expect(isAllowedWebhookUrl("https://user@example.com")).toBe(false);
    expect(isAllowedWebhookUrl("https://:pass@example.com")).toBe(false);
  });

  it("allows the default port and unprivileged ones, never another privileged port", () => {
    expect(isAllowedWebhookUrl("https://hooks.example.com:443/x")).toBe(true);
    expect(isAllowedWebhookUrl("https://hooks.example.com:1024/x")).toBe(true);
    expect(isAllowedWebhookUrl("https://hooks.example.com:8443/x")).toBe(true);
    expect(isAllowedWebhookUrl("https://hooks.example.com:65535/x")).toBe(true);
    for (const port of [1, 22, 25, 80, 1023]) {
      expect(isAllowedWebhookUrl(`https://hooks.example.com:${port}/x`), String(port)).toBe(false);
    }
  });

  it("rejects localhost and names that only mean a local network, case-insensitively and fully qualified", () => {
    for (const url of [
      "https://localhost/x",
      "https://LOCALHOST/x",
      "https://localhost./x",
      "https://app.localhost/x",
      "https://foo.local/x",
      "https://foo.LOCAL/x",
      "https://foo.local./x",
      "https://foo.internal/x",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://nas.lan/x",
      "https://router.home.arpa/x",
      "https://box.localdomain/x",
      "https://wiki.intranet/x",
      "https://mail.corp/x",
    ]) {
      expect(isAllowedWebhookUrl(url), url).toBe(false);
    }
    // Only a whole label counts: these are ordinary public names.
    expect(isAllowedWebhookUrl("https://notlocal.example/x")).toBe(true);
    expect(isAllowedWebhookUrl("https://lan.example.com/x")).toBe(true);
  });

  it("rejects single-label host names, such as a Docker service's", () => {
    for (const url of ["https://redis-rest/x", "https://app:3000/x", "https://metadata/x", "https://./x"]) {
      expect(isAllowedWebhookUrl(url), url).toBe(false);
    }
  });

  it("rejects every IPv4 literal, public ones included", () => {
    for (const url of [
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://172.16.0.1/x",
      "https://192.168.1.1/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://100.64.0.1/x",
      "https://0.0.0.0/x",
      "https://8.8.8.8/x",
      "https://93.184.215.14:8443/x",
    ]) {
      expect(isAllowedWebhookUrl(url), url).toBe(false);
    }
  });

  it("rejects obfuscated IPv4 literals the URL parser normalizes", () => {
    // All of these are 127.0.0.1: decimal, hex, octal, and with zeros implied.
    for (const url of [
      "https://2130706433/",
      "https://0x7f000001/",
      "https://0177.0.0.1/",
      "https://127.1/",
      "https://127.0.0.1./",
      "https://%31%32%37.0.0.1/",
    ]) {
      expect(isAllowedWebhookUrl(url), url).toBe(false);
    }
  });

  it("rejects every IPv6 literal, IPv4-mapped forms included", () => {
    for (const url of [
      "https://[::1]/x",
      "https://[::]/x",
      "https://[fe80::1]/x",
      "https://[fd00:ec2::254]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://[::ffff:7f00:1]/x",
      "https://[::ffff:169.254.169.254]/x",
      "https://[64:ff9b::a00:1]/x",
      "https://[2606:4700::1111]/x",
    ]) {
      expect(isAllowedWebhookUrl(url), url).toBe(false);
    }
  });

  it("rejects a URL longer than MAX_WEBHOOK_URL_LENGTH", () => {
    const long = `https://example.com/${"x".repeat(MAX_WEBHOOK_URL_LENGTH)}`;
    expect(long.length).toBeGreaterThan(MAX_WEBHOOK_URL_LENGTH);
    expect(isAllowedWebhookUrl(long)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isAllowedWebhookUrl("")).toBe(false);
  });
});

describe("the masked webhook URL (multi-tenant mode)", () => {
  const stored = "https://hooks.slack.com/services/T000/B000/XXXXXXXX4f2a";

  it("shows only the origin, and the last four characters of a long path only", () => {
    expect(maskWebhookUrl(stored)).toBe("https://hooks.slack.com/…••••4f2a");
    expect(maskWebhookUrl(stored)).not.toContain("services");
    // A short path or token shows nothing of itself.
    expect(maskWebhookUrl("https://example.com/hooks/notify?k=a1b2")).toBe("https://example.com/…••••");
  });

  it("never lets the form save anything made from a mask, though it would pass as a URL", () => {
    const mask = maskWebhookUrl(stored);
    for (const edited of [`${mask}x`, "https://hooks.slack.com/…•••4f2a", "https://hooks.slack.com/…4f2a"]) {
      expect(isAllowedWebhookUrl(edited)).toBe(true);
      expect(webhookFieldProblem(edited, mask)).toBe(true);
    }
    expect(webhookFieldProblem(mask, mask)).toBe(false);
    expect(webhookFieldProblem(mask, null)).toBe(true);
    expect(webhookFieldProblem("https://new.example/hook", mask)).toBe(false);
  });
});
