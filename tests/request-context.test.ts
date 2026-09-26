import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CookieJar,
  clientIp,
  currentCookies,
  currentHeaders,
  currentRequestId,
  defer,
  flushDeferred,
  isHttpsRequest,
  requestIdFrom,
  runWithRequest,
} from "@/lib/request-context";

function jar(): CookieJar & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (name) => (store.has(name) ? { value: store.get(name)! } : undefined),
    set: (name, value) => {
      store.set(name, value);
    },
    delete: (name) => {
      store.delete(name);
    },
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runWithRequest", () => {
  it("scopes the request id to the async chain, also across interleaved requests", async () => {
    expect(currentRequestId()).toBeNull();
    const seen = await Promise.all([
      runWithRequest({ requestId: "a", route: "x" }, async () => {
        await wait(5);
        return currentRequestId();
      }),
      runWithRequest({ requestId: "b", route: "x" }, async () => {
        await wait(1);
        return currentRequestId();
      }),
    ]);
    expect(seen).toEqual(["a", "b"]);
    expect(currentRequestId()).toBeNull();
  });

  it("hands out the injected headers and cookie jar", async () => {
    const cookies = jar();
    const headers = new Headers({ "x-test": "1" });
    await runWithRequest({ requestId: "a", route: "x", headers, cookies }, async () => {
      expect((await currentHeaders()).get("x-test")).toBe("1");
      (await currentCookies()).set("usageratio_session", "s");
    });
    expect(cookies.store.get("usageratio_session")).toBe("s");
  });
});

describe("clientIp", () => {
  const forwarded = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-real-ip": "198.51.100.2" });

  it("takes the first forwarded address by default", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_PROXY", "");
    await runWithRequest({ requestId: "a", route: "x", headers: forwarded }, async () => {
      expect(await clientIp()).toBe("203.0.113.9");
    });
  });

  it("falls back to x-real-ip, then to unknown", async () => {
    vi.stubEnv("VERCEL", "");
    await runWithRequest(
      { requestId: "a", route: "x", headers: new Headers({ "x-real-ip": "198.51.100.2" }) },
      async () => {
        expect(await clientIp()).toBe("198.51.100.2");
      },
    );
    await runWithRequest({ requestId: "a", route: "x", headers: new Headers() }, async () => {
      expect(await clientIp()).toBe("unknown");
    });
  });

  it("ignores the forwarding headers when TRUST_PROXY says so, unless on Vercel", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_PROXY", "false");
    await runWithRequest({ requestId: "a", route: "x", headers: forwarded }, async () => {
      expect(await clientIp()).toBe("unknown");
    });
    vi.stubEnv("VERCEL", "1");
    await runWithRequest({ requestId: "a", route: "x", headers: forwarded }, async () => {
      expect(await clientIp()).toBe("203.0.113.9");
    });
  });
});

describe("isHttpsRequest", () => {
  it("follows COOKIE_SECURE when set", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("COOKIE_SECURE", "false");
    await runWithRequest({ requestId: "a", route: "x", headers: new Headers() }, async () => {
      expect(await isHttpsRequest()).toBe(false);
    });
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("COOKIE_SECURE", "true");
    await runWithRequest({ requestId: "a", route: "x", headers: new Headers() }, async () => {
      expect(await isHttpsRequest()).toBe(true);
    });
  });

  it("is true on Vercel and behind an https proxy, false otherwise", async () => {
    vi.stubEnv("COOKIE_SECURE", "");
    vi.stubEnv("VERCEL", "1");
    await runWithRequest({ requestId: "a", route: "x", headers: new Headers() }, async () => {
      expect(await isHttpsRequest()).toBe(true);
    });
    vi.stubEnv("VERCEL", "");
    await runWithRequest(
      { requestId: "a", route: "x", headers: new Headers({ "x-forwarded-proto": "https, http" }) },
      async () => {
        expect(await isHttpsRequest()).toBe(true);
      },
    );
    await runWithRequest({ requestId: "a", route: "x", headers: new Headers() }, async () => {
      expect(await isHttpsRequest()).toBe(false);
    });
  });
});

describe("defer", () => {
  it("runs the task inline outside a Next request, and in a context that asks for it", async () => {
    const ran: string[] = [];
    defer(async () => {
      await wait(1);
      ran.push("outside");
    });
    await runWithRequest({ requestId: "a", route: "x", deferInline: true }, async () => {
      defer(() => {
        ran.push("inline");
      });
    });
    await flushDeferred();
    expect(ran.sort()).toEqual(["inline", "outside"]);
  });

  it("never throws: a failing task is logged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    defer(() => {
      throw new Error("kaput");
    });
    await flushDeferred();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain("defer.failed");
  });
});

describe("requestIdFrom", () => {
  it("prefers the platform id, then a proxy's, then makes one up", () => {
    expect(requestIdFrom(new Headers({ "x-vercel-id": "fra1::abc-123", "x-request-id": "r" }))).toBe("fra1::abc-123");
    expect(requestIdFrom(new Headers({ "x-request-id": "r-1" }))).toBe("r-1");
    expect(requestIdFrom(new Headers())).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("does not trust an id that could not be logged safely", () => {
    expect(requestIdFrom(new Headers({ "x-request-id": "bad id\n" }))).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom(new Headers({ "x-request-id": "x".repeat(200) }))).toMatch(/^[0-9a-f-]{36}$/);
  });
});
