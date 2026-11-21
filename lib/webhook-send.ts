import { lookup as dnsLookup } from "node:dns/promises";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isAllowedWebhookUrl, type WebhookResult } from "@/lib/webhook";
import { version } from "@/package.json";

/**
 * Sends an alerts webhook (lib/alerts.ts), server-side only. The URL has passed lib/webhook.ts
 * `isAllowedWebhookUrl` when it was saved and passes it again here; what this module adds is the
 * check on where the request actually goes:
 *
 * 1. The host name is resolved once, here, and every address it resolves to must be public
 *    (`isPublicAddress`). One private address among public ones refuses the whole send.
 * 2. The connection goes to those checked addresses and nowhere else: `node:https` is given a
 *    `lookup` that answers with them instead of resolving the name again (`pinnedLookup`). A name
 *    that resolved to a public address when it was saved, or a second ago, and to a private one
 *    now (DNS rebinding) is refused at step 1; one that changes between step 1 and the connect
 *    cannot be followed, since nothing resolves it a second time. TLS is still checked against
 *    the host name.
 * 3. A redirect is never followed: a 3xx is a failed send, like any other non-2xx.
 * 4. One deadline covers the lookup, the connect, the TLS handshake and the response headers;
 *    the response body is never read (the socket is closed once the status line is in), and the
 *    headers are capped at `MAX_RESPONSE_HEADER_BYTES`.
 *
 * `fetch` cannot do step 2 without undici's own Agent, which is not a dependency of this app;
 * `node:https` can, with no dependency at all.
 */

/** Enough for any real webhook's response headers; a bigger answer fails the send. */
export const MAX_RESPONSE_HEADER_BYTES = 16 * 1024;

const DEFAULT_TIMEOUT_MS = 5000;

/** The part of `RequestInit` a webhook send uses: what a transport is handed. */
export interface WebhookRequestInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** Posts one request and answers with its status; rejects on a network failure, a refusal or the deadline. */
export type WebhookTransport = (url: string, init: WebhookRequestInit) => Promise<{ status: number }>;

const NOT_PUBLIC = "webhook host does not resolve to a public address";

/** A refusal of the target itself (what it resolves to), as opposed to a network failure. */
export class WebhookTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookTargetError";
  }
}

// ── Which addresses are public ──────────────────────────────────────────────

/** Not reachable on the public internet, or not meant to be: [base, prefix length]. */
const NON_PUBLIC_IPV4: readonly [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private (RFC 1918)
  ["100.64.0.0", 10], // carrier-grade NAT, and some clouds' metadata (100.100.100.200)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, and most clouds' metadata (169.254.169.254)
  ["172.16.0.0", 12], // private (RFC 1918)
  ["192.0.0.0", 24], // IETF protocol assignments, and Oracle Cloud's metadata (192.0.0.192)
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // the retired 6to4 relay anycast
  ["192.168.0.0", 16], // private (RFC 1918)
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address
];

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function inIPv4Range(value: number, base: string, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(ipv4ToNumber(base) / size);
}

function isPublicIPv4(value: number): boolean {
  return !NON_PUBLIC_IPV4.some(([base, bits]) => inIPv4Range(value, base, bits));
}

/** The eight 16-bit groups of an address `isIP` has already called IPv6 (a zone id, `%eth0`, dropped). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase().split("%")[0]!;
  // A dotted IPv4 tail (`::ffff:1.2.3.4`) becomes the two groups it stands for.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const value = ipv4ToNumber(tail);
    text = `${text.slice(0, lastColon + 1)}${Math.floor(value / 65536).toString(16)}:${(value % 65536).toString(16)}`;
  }
  const halves = text.split("::");
  const head = halves[0]!;
  const rest = halves[1];
  const before = head === "" ? [] : head.split(":");
  const after = rest === undefined || rest === "" ? [] : rest.split(":");
  const zeros = new Array<string>(8 - before.length - after.length).fill("0");
  return [...before, ...zeros, ...after].map((group) => Number.parseInt(group, 16));
}

function embeddedIPv4(high: number, low: number): number {
  return high * 65536 + low;
}

function isPublicIPv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const zeroUpTo5 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::ffff:a.b.c.d, IPv4-mapped: as public as the IPv4 address it maps to.
  if (zeroUpTo5 && g5 === 0xffff) return isPublicIPv4(embeddedIPv4(g6, g7));
  // ::/96: the unspecified address, loopback (::1), and the retired IPv4-compatible form.
  if (zeroUpTo5 && g5 === 0) return false;
  // 64:ff9b::/96, NAT64: a DNS64 resolver hands these out for IPv4-only names, so the IPv4
  // address inside decides. 64:ff9b:1::/48 is the local-use NAT64 prefix: never public.
  if (g0 === 0x64 && g1 === 0xff9b) {
    return g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && isPublicIPv4(embeddedIPv4(g6, g7));
  }
  // 2002::/16, 6to4: the IPv4 address inside decides.
  if (g0 === 0x2002) return isPublicIPv4(embeddedIPv4(g1, g2));
  // 2001::/23 (IETF protocol assignments, Teredo among them) and 2001:db8::/32 (documentation).
  if (g0 === 0x2001 && (g1 < 0x200 || g1 === 0xdb8)) return false;
  // 3fff::/20, documentation as well.
  if (g0 === 0x3fff && g1 < 0x1000) return false;
  // Everything else outside 2000::/3, global unicast, is not public: unique-local (fc00::/7, where
  // AWS's fd00:ec2::254 metadata address lives), link-local (fe80::/10), multicast (ff00::/8), …
  return (g0 & 0xe000) === 0x2000;
}

/** Whether a webhook may connect to `address` (a resolver's answer): a public unicast IPv4 or IPv6 address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIPv4(ipv4ToNumber(address));
  if (family === 6) return isPublicIPv6(ipv6Groups(address));
  return false;
}

// ── The pinned request ──────────────────────────────────────────────────────

/** Every address `host` resolves to, IPv4 and IPv6, in the resolver's order. */
export async function resolveHost(host: string): Promise<string[]> {
  const results = await dnsLookup(host, { all: true });
  return results.map((result) => result.address);
}

/**
 * A `lookup` for `node:net` that answers with `addresses`, already checked, whatever it is asked:
 * the connection can only go where the check said it may.
 */
export function pinnedLookup(addresses: string[]): LookupFunction {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_hostname, options, callback) => {
    // Happy Eyeballs (`autoSelectFamily`, on by default) asks for every address; a plain connect for one.
    if (options.all) callback(null, entries);
    else callback(null, entries[0]!.address, entries[0]!.family);
  };
}

/** `promise`, or `signal`'s reason as soon as it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface PinnedPostDeps {
  /** Resolves a host name to its addresses; DNS by default. */
  resolve?: (host: string) => Promise<string[]>;
  /** Which resolved addresses may be connected to; `isPublicAddress` by default. */
  isAllowedAddress?: (address: string) => boolean;
  /** `node:https`'s `request` by default; a test hands in `node:http`'s to reach a local server. */
  request?: (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;
}

/** The default webhook transport: resolve, check every address, then connect to those addresses only. */
export async function pinnedPost(
  rawUrl: string,
  init: WebhookRequestInit,
  deps: PinnedPostDeps = {},
): Promise<{ status: number }> {
  const { resolve = resolveHost, isAllowedAddress = isPublicAddress, request = httpsRequest } = deps;
  const url = new URL(rawUrl);
  const host = url.hostname;

  // One message for a name that does not resolve and one that resolves to a private address, with
  // no address in it: it reaches the settings panel, and must not tell a user in `open` mode which
  // internal names this server's resolver knows.
  let addresses: string[];
  try {
    addresses = await untilAborted(resolve(host), init.signal);
  } catch (error) {
    if (init.signal.aborted) throw error;
    throw new WebhookTargetError(NOT_PUBLIC);
  }
  if (addresses.length === 0 || !addresses.every(isAllowedAddress)) throw new WebhookTargetError(NOT_PUBLIC);

  return new Promise((settle, fail) => {
    const req = request(
      {
        host,
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: init.method,
        headers: { ...init.headers, "Content-Length": String(Buffer.byteLength(init.body)) },
        lookup: pinnedLookup(addresses),
        agent: false,
        maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
        signal: init.signal,
      },
      (response) => {
        settle({ status: Number(response.statusCode) });
        // Nothing in the body is used: close the socket instead of reading however much is sent.
        response.destroy();
      },
    );
    req.on("error", fail);
    req.end(init.body);
  });
}

// ── Sending ─────────────────────────────────────────────────────────────────

const defaultTransport: WebhookTransport = (url, init) => pinnedPost(url, init);
let transport: WebhookTransport = defaultTransport;

/** Replaces the transport `sendWebhook` uses (null: the pinned default), under Vitest only. */
export function setWebhookTransportForTests(next: WebhookTransport | null): void {
  if (!process.env.VITEST) throw new Error("The webhook transport can only be swapped out under Vitest.");
  transport = next ?? defaultTransport;
}

/**
 * POSTs `payload` as JSON, with no retries: a threshold alert is best-effort, and retrying
 * against a broken webhook would only pile up more failed calls. Never throws.
 */
export async function sendWebhook(
  url: string,
  payload: unknown,
  options: { timeoutMs?: number } = {},
): Promise<WebhookResult> {
  // A stored URL was checked when it was saved; the policy may have grown stricter since.
  if (!isAllowedWebhookUrl(url)) return { ok: false, status: null, error: "webhook URL is not allowed" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const { status } = await transport(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `usageratio/${version}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (status >= 300 && status < 400) {
      return { ok: false, status, error: `webhook responded ${status}; redirects are not followed` };
    }
    if (status < 200 || status >= 300) return { ok: false, status, error: `webhook responded ${status}` };
    return { ok: true, status };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
