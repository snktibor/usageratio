/**
 * The alerts webhook's URL policy (lib/alerts.ts), shared by the settings panel's form
 * (components/settings), its validation (lib/settings.ts), the "send test" endpoint
 * (app/api/alerts/test/route.ts) and the sender itself (lib/webhook-send.ts). It runs in the
 * browser too, so it only looks at the URL: what the host name resolves to is checked when the
 * webhook is sent, on the address the request then connects to (lib/webhook-send.ts), since a
 * name can resolve to a public address now and a private one later (DNS rebinding).
 *
 * What a URL needs:
 * - https, no `user:password@`, at most `MAX_WEBHOOK_URL_LENGTH` characters;
 * - the default port, 443, or an unprivileged one (1024-65535): never 22, 25, 80 or the like;
 * - a host name with a dot in it, never an IP address however written (`127.1`, `0x7f000001`,
 *   `[::ffff:7f00:1]`): a public webhook always has a name, and the name is what the TLS
 *   certificate is checked against;
 * - not `localhost`, and not under a name that only ever means a local network (`.local`,
 *   `.internal`, `.lan`, `.home.arpa`, …).
 */

export const MAX_WEBHOOK_URL_LENGTH = 2048;

/** A name ending in one of these only ever means something on a local network (or this machine). */
const LOCAL_SUFFIXES = ["localhost", "local", "localdomain", "internal", "intranet", "lan", "corp", "home.arpa"];

const MIN_UNPRIVILEGED_PORT = 1024;

function isIpLiteral(host: string): boolean {
  // The URL parser has already turned every IPv4 spelling into dotted decimal, and keeps IPv6 bracketed.
  return host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isLocalName(host: string): boolean {
  return LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Whether `raw` may be used as an alerts webhook target; see the policy at the top of this file. */
export function isAllowedWebhookUrl(raw: string): boolean {
  if (raw.length === 0 || raw.length > MAX_WEBHOOK_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  // `url.port` is "" for the scheme's default port (443), which the parser drops even when spelled out.
  if (url.port !== "" && Number(url.port) < MIN_UNPRIVILEGED_PORT) return false;

  // A trailing dot (`localhost.`) is the same name, fully qualified.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (isIpLiteral(host)) return false;
  if (!host.includes(".")) return false; // `localhost`, or a single-label name such as a Docker service
  return !isLocalName(host);
}

export type WebhookResult = { ok: true; status: number } | { ok: false; status: number | null; error: string };

/**
 * The webhook URL as a multi-tenant workspace shows it to everyone, its owner
 * included (the design's decision 3): it can be replaced, never read back,
 * since a member who could read it could post into the owner's Slack. The
 * mask is for display only: the settings form keeps the stored URL by saying
 * so (`keepWebhook`), never by sending the mask back. Only the origin stays,
 * and the last four characters of a long path: `https://hooks.slack.com/…••••4f2a`.
 */
export const WEBHOOK_MASK_DOTS = "••••";

export function maskWebhookUrl(url: string): string {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return WEBHOOK_MASK_DOTS;
  }
  // A short path or token would give away too much of itself: then nothing of it shows.
  const tail = url.length - origin.length >= 32 ? url.slice(-4) : "";
  return `${origin}/…${WEBHOOK_MASK_DOTS}${tail}`;
}

/** Whether a value carries any of the mask's characters: a mask, or one edited by hand. Never a URL to save. */
export function isMaskedWebhookUrl(value: string): boolean {
  return value.includes("•") || value.includes("…");
}

/**
 * Whether the settings panel's webhook field (trimmed, not empty) cannot be saved: not an allowed
 * URL, or anything made from a mask. The stored URL's own mask (`storedMask`), untouched, is fine:
 * the form then asks to keep the stored URL.
 */
export function webhookFieldProblem(value: string, storedMask: string | null): boolean {
  if (storedMask !== null && value === storedMask) return false;
  return isMaskedWebhookUrl(value) || !isAllowedWebhookUrl(value);
}
