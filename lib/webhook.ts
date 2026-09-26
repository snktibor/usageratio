import { version } from "@/package.json";

/**
 * The alerts webhook (lib/alerts.ts): a URL allow-list so a self-hosted
 * deployment cannot be pointed at its own private network, and the actual
 * POST. Both are used by the settings panel's validation (lib/settings.ts)
 * and by the "send test" endpoint (app/api/alerts/test/route.ts).
 *
 * What is NOT defended: DNS rebinding, where a hostname that passes
 * `isAllowedWebhookUrl` resolves to a private address only when the webhook
 * actually fires (`fetch` re-resolves it then, after this check). Vercel
 * functions have no private network to reach in the first place; a
 * self-hoster who is exposed to that should filter egress in front of the
 * container rather than rely on this check alone.
 */

export const MAX_WEBHOOK_URL_LENGTH = 2048;

const LOOPBACK_V4 = /^127\./;
const LINK_LOCAL_V4 = /^169\.254\./;
// 172.16.0.0/12: the second octet 16-31.
const RFC1918 = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./];
// 100.64.0.0/10 (carrier-grade NAT): the second octet 64-127.
const CGNAT_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

function isBlockedIPv4(host: string): boolean {
  return LOOPBACK_V4.test(host) || LINK_LOCAL_V4.test(host) || CGNAT_V4.test(host) || RFC1918.some((p) => p.test(host));
}

function looksLikeIPv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** `new URL(...).hostname` keeps an IPv6 literal's brackets; strip them to get the address. */
function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** An IPv4-mapped IPv6 address (`::ffff:a:b`, hex groups) restated as dotted decimal. */
function ipv4MappedToDotted(host: string): string | null {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!match?.[1] || !match[2]) return null;
  const hi = Number.parseInt(match[1], 16);
  const lo = Number.parseInt(match[2], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isBlockedIPv6(host: string): boolean {
  if (host === "::1") return true; // loopback
  if (host.startsWith("fe80:")) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7, unique local
  const mapped = ipv4MappedToDotted(host);
  return mapped !== null && isBlockedIPv4(mapped);
}

/**
 * Whether `raw` may be used as an alerts webhook target: https, no userinfo,
 * at most `MAX_WEBHOOK_URL_LENGTH` characters, and a host that is not
 * "localhost", a `.local`/`.internal` name, or a loopback/RFC1918/link-local/
 * CGNAT/unique-local IP literal.
 */
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

  const host = unbracket(url.hostname).toLowerCase();
  if (host === "" || host === "localhost") return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (looksLikeIPv4(host)) return !isBlockedIPv4(host);
  if (host.includes(":")) return !isBlockedIPv6(host);
  return true;
}

export type WebhookResult = { ok: true; status: number } | { ok: false; status: number | null; error: string };

/**
 * POSTs `payload` as JSON, with no retries: a threshold alert is best-effort,
 * and retrying against a broken webhook would only pile up more failed calls.
 */
export async function sendWebhook(
  url: string,
  payload: unknown,
  options: { timeoutMs?: number } = {},
): Promise<WebhookResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `usageratio/${version}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, status: response.status, error: `webhook responded ${response.status}` };
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
