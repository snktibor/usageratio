import { EventEmitter } from "node:events";
import {
  type ClientRequest,
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPublicAddress,
  MAX_RESPONSE_HEADER_BYTES,
  type PinnedPostDeps,
  pinnedLookup,
  pinnedPost,
  resolveHost,
  sendWebhook,
  setWebhookTransportForTests,
  type WebhookRequestInit,
  WebhookTargetError,
} from "@/lib/webhook-send";
import { version } from "@/package.json";

afterEach(() => {
  vi.unstubAllEnvs();
  setWebhookTransportForTests(null);
  vi.restoreAllMocks();
});

function init(signal: AbortSignal = new AbortController().signal): WebhookRequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"a":1}', signal };
}

/** A `request` that never touches the network: records its options, then answers `status`. */
function fakeRequest(status = 200) {
  const calls: RequestOptions[] = [];
  const request = vi.fn((options: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
    calls.push(options);
    const req = new EventEmitter() as EventEmitter & { end: (body: string) => void };
    req.end = () => {
      queueMicrotask(() => onResponse({ statusCode: status, destroy: () => undefined } as unknown as IncomingMessage));
    };
    return req as unknown as ClientRequest;
  });
  return { request, calls };
}

/** What a `lookup` answers when asked for every address, and when asked for one. */
function lookupAnswers(options: RequestOptions): { all: unknown; one: unknown[] } {
  const lookup = options.lookup!;
  let all: unknown;
  let one: unknown[] = [];
  lookup("anything.example", { all: true }, (_error, addresses) => {
    all = addresses;
  });
  lookup("anything.example", {}, (_error, address, family) => {
    one = [address, family];
  });
  return { all, one };
}

describe("isPublicAddress", () => {
  it("accepts public IPv4 addresses, the edges of the blocked ranges included", () => {
    for (const address of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.215.14",
      "9.255.255.255",
      "11.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "126.255.255.255",
      "128.0.0.0",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.255.255",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "223.255.255.255",
    ]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("refuses private, loopback, link-local, CGNAT, metadata, documentation, multicast and reserved IPv4", () => {
    for (const address of [
      "0.0.0.0",
      "0.1.2.3",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1",
      "100.100.100.200",
      "100.127.255.255",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.192",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "239.255.255.250",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("accepts global unicast IPv6", () => {
    for (const address of [
      "2606:4700:4700::1111",
      "2a00:1450:4001:80b::200e",
      "2001:4860:4860::8888",
      "2001:200::1",
      "3fff:1000::1",
      "2001:db9::1",
      "2c0f:fb50:4002::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("refuses loopback, unspecified, unique-local, link-local, multicast, documentation and Teredo IPv6", () => {
    for (const address of [
      "::",
      "::1",
      "::7f00:1",
      "0:1::",
      "1::",
      "1:2:3:4:5:6:7:8",
      "100::1",
      "fc00::1",
      "fd00:ec2::254",
      "fe80::1",
      "fe80::1%eth0",
      "fec0::1",
      "ff02::1",
      "2001::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2001:db8::1",
      "3fff::1",
      "3fff:fff::1",
      "4000::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("decides IPv4-mapped, NAT64 and 6to4 addresses by the IPv4 address inside", () => {
    // IPv4-mapped, dotted and in hex.
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::FFFF:7f00:1")).toBe(false);
    expect(isPublicAddress("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("::ffff:808:808")).toBe(true);
    // NAT64 (64:ff9b::/96); the local-use prefix and anything past the /96 never.
    expect(isPublicAddress("64:ff9b::808:808")).toBe(true);
    expect(isPublicAddress("64:ff9b::8.8.8.8")).toBe(true);
    expect(isPublicAddress("64:ff9b::a00:1")).toBe(false);
    expect(isPublicAddress("64:ff9b::127.0.0.1")).toBe(false);
    expect(isPublicAddress("64:ff9b:1::808:808")).toBe(false);
    expect(isPublicAddress("64:ff9b:0:1::808:808")).toBe(false);
    expect(isPublicAddress("64:ff9b:0:0:1::808")).toBe(false);
    expect(isPublicAddress("64:ff9b::1:808:808")).toBe(false);
    // 6to4 (2002::/16).
    expect(isPublicAddress("2002:808:808::1")).toBe(true);
    expect(isPublicAddress("2002:c0a8:101::1")).toBe(false);
    expect(isPublicAddress("2002:7f00:1::")).toBe(false);
  });

  it("refuses anything that is not an IP address", () => {
    for (const value of ["", "example.com", "localhost", "999.0.0.1", "1.2.3", "::g"]) {
      expect(isPublicAddress(value), value).toBe(false);
    }
  });
});

describe("pinnedLookup", () => {
  it("answers with the checked addresses, whichever way it is asked", () => {
    const answers = lookupAnswers({
      lookup: pinnedLookup(["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]),
    });
    expect(answers.all).toEqual([
      { address: "93.184.215.14", family: 4 },
      { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 },
    ]);
    expect(answers.one).toEqual(["93.184.215.14", 4]);
  });
});

describe("resolveHost", () => {
  it("resolves a name to all of its addresses", async () => {
    const addresses = await resolveHost("localhost");
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.some((address) => address === "127.0.0.1" || address === "::1")).toBe(true);
  });
});

describe("pinnedPost", () => {
  it("connects to the address it checked, on the URL's port and path, with the body's length", async () => {
    const { request, calls } = fakeRequest(204);
    const resolve = vi.fn().mockResolvedValue(["93.184.215.14"]);
    const result = await pinnedPost("https://hooks.example.com/services/x?y=1", init(), { resolve, request });

    expect(result).toEqual({ status: 204 });
    expect(resolve).toHaveBeenCalledWith("hooks.example.com");
    const options = calls[0]!;
    expect(options).toMatchObject({
      host: "hooks.example.com",
      port: 443,
      path: "/services/x?y=1",
      method: "POST",
      agent: false,
      maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
    });
    expect(options.headers).toMatchObject({ "Content-Type": "application/json", "Content-Length": "7" });
    expect(lookupAnswers(options).one).toEqual(["93.184.215.14", 4]);

    await pinnedPost("https://hooks.example.com:8443/x", init(), { resolve, request });
    expect(calls[1]!.port).toBe(8443);
  });

  it("refuses a name with any non-public address among its answers, before connecting", async () => {
    const { request } = fakeRequest();
    for (const addresses of [["10.0.0.1"], ["93.184.215.14", "169.254.169.254"], ["::1"], ["::ffff:127.0.0.1"]]) {
      const attempt = pinnedPost("https://hooks.example.com/x", init(), {
        resolve: async () => addresses,
        request,
      });
      await expect(attempt).rejects.toThrow(WebhookTargetError);
      await expect(attempt).rejects.toThrow("webhook host does not resolve to a public address");
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to nothing", async () => {
    const { request } = fakeRequest();
    await expect(
      pinnedPost("https://hooks.example.com/x", init(), { resolve: async () => [], request }),
    ).rejects.toThrow("webhook host does not resolve to a public address");
    expect(request).not.toHaveBeenCalled();
  });

  it("defeats DNS rebinding: public when saved, private when sent, and never resolved twice for one send", async () => {
    const answers = [["93.184.215.14"], ["127.0.0.1"]];
    const resolve = vi.fn(async () => answers.shift()!);
    const { request, calls } = fakeRequest();
    const deps: PinnedPostDeps = { resolve, request };
    setWebhookTransportForTests((url, requestInit) => pinnedPost(url, requestInit, deps));

    // The URL passes every check a save makes, and the first send goes to the public address.
    const first = await sendWebhook("https://rebind.example.com/hook", { n: 1 });
    expect(first).toEqual({ ok: true, status: 200 });
    // The connect's own lookup answers with that address, even asked after the name has moved.
    expect(lookupAnswers(calls[0]!).all).toEqual([{ address: "93.184.215.14", family: 4 }]);

    // Now the name points at loopback: refused, and nothing is connected to.
    const second = await sendWebhook("https://rebind.example.com/hook", { n: 2 });
    expect(second).toEqual({ ok: false, status: null, error: "webhook host does not resolve to a public address" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("gives up on a resolver that does not answer before the deadline", async () => {
    const controller = new AbortController();
    const { request } = fakeRequest();
    const attempt = pinnedPost("https://hooks.example.com/x", init(controller.signal), {
      resolve: () => new Promise<string[]>(() => undefined),
      request,
    });
    controller.abort(new Error("deadline"));
    await expect(attempt).rejects.toThrow("deadline");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not start with a signal that has already aborted", async () => {
    const { request } = fakeRequest();
    const resolve = vi.fn().mockResolvedValue(["93.184.215.14"]);
    await expect(
      pinnedPost("https://hooks.example.com/x", init(AbortSignal.abort(new Error("too late"))), { resolve, request }),
    ).rejects.toThrow("too late");
    expect(request).not.toHaveBeenCalled();
  });

  it("answers a resolver's failure like a private address: no oracle for internal names", async () => {
    const { request } = fakeRequest();
    await expect(
      pinnedPost("https://hooks.example.com/x", init(), {
        resolve: async () => {
          throw new Error("getaddrinfo ENOTFOUND hooks.example.com");
        },
        request,
      }),
    ).rejects.toThrow("webhook host does not resolve to a public address");
  });
});

describe("pinnedPost against a real server", () => {
  let server: Server | null = null;
  let seen: { method?: string; url?: string; host?: string; body: string }[] = [];

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = null;
    seen = [];
  });

  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, host: req.headers.host, body });
        handler(req, res);
      });
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    return (server!.address() as AddressInfo).port;
  }

  /** Over plain http to the local server, with the name pinned to 127.0.0.1 (which is otherwise refused). */
  function pinToLocalServer(port: number): (rawUrl: string) => string {
    const deps: PinnedPostDeps = {
      resolve: async () => ["127.0.0.1"],
      isAllowedAddress: () => true,
      request: httpRequest,
    };
    setWebhookTransportForTests((url, requestInit) => pinnedPost(url, requestInit, deps));
    return (rawUrl) => rawUrl.replace("PORT", String(port));
  }

  it("reaches the pinned address under a name no resolver knows, with the name in Host", async () => {
    const port = await listen((_req, res) => res.writeHead(200).end("ok"));
    const url = pinToLocalServer(port);
    const result = await sendWebhook(url("https://hooks.unresolvable.test:PORT/hook?k=1"), { hello: "world" });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(seen).toEqual([
      { method: "POST", url: "/hook?k=1", host: `hooks.unresolvable.test:${port}`, body: '{"hello":"world"}' },
    ]);
  });

  it("never follows a redirect", async () => {
    const port = await listen((req, res) => {
      if (req.url === "/hook") res.writeHead(307, { Location: "/elsewhere" }).end();
      else res.writeHead(200).end();
    });
    const url = pinToLocalServer(port);
    const result = await sendWebhook(url("https://hooks.unresolvable.test:PORT/hook"), {});

    expect(result).toEqual({ ok: false, status: 307, error: "webhook responded 307; redirects are not followed" });
    expect(seen.map((entry) => entry.url)).toEqual(["/hook"]);
  });

  it("does not read a response body, however large", async () => {
    let closed = false;
    const port = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      const chunk = "x".repeat(64 * 1024);
      const pump = () => {
        while (!res.destroyed && res.write(chunk)) {
          // Keeps writing until the socket pushes back.
        }
        if (!res.destroyed) res.once("drain", pump);
      };
      res.on("close", () => {
        closed = true;
      });
      pump();
    });
    const url = pinToLocalServer(port);
    const result = await sendWebhook(url("https://hooks.unresolvable.test:PORT/hook"), {}, { timeoutMs: 2000 });

    expect(result).toEqual({ ok: true, status: 200 });
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it("fails on response headers over the cap", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "X-Padding": "x".repeat(MAX_RESPONSE_HEADER_BYTES + 1024) }).end();
    });
    const url = pinToLocalServer(port);
    const result = await sendWebhook(url("https://hooks.unresolvable.test:PORT/hook"), {});

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
  });

  it("gives up on a server that never answers", async () => {
    const port = await listen(() => undefined);
    const url = pinToLocalServer(port);
    const started = Date.now();
    const result = await sendWebhook(url("https://hooks.unresolvable.test:PORT/hook"), {}, { timeoutMs: 200 });

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("sendWebhook", () => {
  it("POSTs the payload as JSON with a usageratio User-Agent", async () => {
    const transport = vi.fn().mockResolvedValue({ status: 200 });
    setWebhookTransportForTests(transport);
    const result = await sendWebhook("https://example.com/hook", { hello: "world" });
    expect(result).toEqual({ ok: true, status: 200 });

    expect(transport).toHaveBeenCalledTimes(1);
    const [url, requestInit] = transport.mock.calls[0]! as [string, WebhookRequestInit];
    expect(url).toBe("https://example.com/hook");
    expect(requestInit.method).toBe("POST");
    expect(requestInit.headers["Content-Type"]).toBe("application/json");
    expect(requestInit.headers["User-Agent"]).toBe(`usageratio/${version}`);
    expect(JSON.parse(requestInit.body)).toEqual({ hello: "world" });
  });

  it("reports a non-2xx response as ok:false with its status", async () => {
    for (const status of [101, 404, 500]) {
      setWebhookTransportForTests(vi.fn().mockResolvedValue({ status }));
      expect(await sendWebhook("https://example.com/hook", {})).toEqual({
        ok: false,
        status,
        error: `webhook responded ${status}`,
      });
    }
  });

  it("reports a failure as ok:false with no status, and never retries", async () => {
    const transport = vi.fn().mockRejectedValue(new Error("network down"));
    setWebhookTransportForTests(transport);
    expect(await sendWebhook("https://example.com/hook", {})).toEqual({
      ok: false,
      status: null,
      error: "network down",
    });
    expect(transport).toHaveBeenCalledTimes(1);

    setWebhookTransportForTests(vi.fn().mockRejectedValue("not an Error"));
    expect(await sendWebhook("https://example.com/hook", {})).toEqual({
      ok: false,
      status: null,
      error: "not an Error",
    });
  });

  it("refuses a URL the policy does not allow without sending anything", async () => {
    const transport = vi.fn().mockResolvedValue({ status: 200 });
    setWebhookTransportForTests(transport);
    for (const url of [
      "http://example.com/hook",
      "https://127.0.0.1/hook",
      "https://localhost/hook",
      "https://redis-rest/x",
    ]) {
      expect(await sendWebhook(url, {}), url).toEqual({ ok: false, status: null, error: "webhook URL is not allowed" });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("aborts the transport at the deadline", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      setWebhookTransportForTests(
        (_url, requestInit) =>
          new Promise((_settle, fail) => {
            requestInit.signal.addEventListener("abort", () => {
              aborted = true;
              fail(new Error("aborted"));
            });
          }),
      );
      const settled = sendWebhook("https://example.com/hook", {}, { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await settled).toEqual({ ok: false, status: null, error: "aborted" });
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the pinned transport by default: a name that does not resolve fails, without throwing", async () => {
    const result = await sendWebhook("https://usageratio-webhook-test.invalid/hook", {}, { timeoutMs: 3000 });
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
  });

  it("cannot have its transport swapped outside Vitest", () => {
    vi.stubEnv("VITEST", "");
    expect(() => setWebhookTransportForTests(null)).toThrow("only be swapped out under Vitest");
  });
});
