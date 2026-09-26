import { errors as upstash } from "@upstash/redis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, json, readJsonBody, requireBearer, requireSameOrigin, withApiHandler } from "@/lib/api";
import { StorageNotConfiguredError } from "@/lib/redis";
import { currentCookies, runWithRequest } from "@/lib/request-context";
import { createToken, revokeToken } from "@/lib/tokens";
import { useRedis } from "./helpers/redis-fixture";
import { fakeCookieJar, withRequest } from "./helpers/request";

const URL = "http://localhost:3000/api/usage";

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(URL, { method: "POST", body, headers });
}

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("json / apiError", () => {
  it("answers JSON that is never cached", async () => {
    const response = json({ ok: true }, 201, { "X-Extra": "1" });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-extra")).toBe("1");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("builds the error envelope with the request id, and the headers a status needs", async () => {
    await runWithRequest({ requestId: "req-9", route: "x" }, async () => {
      const unavailable = apiError("storage_unavailable", 503);
      expect(unavailable.headers.get("retry-after")).toBe("60");
      expect(await unavailable.json()).toEqual({ error: "storage_unavailable", requestId: "req-9" });

      const limited = apiError("rate_limited", 429, { retryAfterSeconds: 90.2 });
      expect(limited.headers.get("retry-after")).toBe("91");
      expect(await limited.json()).toEqual({ error: "rate_limited", requestId: "req-9", retryAfterSeconds: 90.2 });

      const bearer = apiError("unauthorized", 401, { scheme: "bearer" });
      expect(bearer.headers.get("www-authenticate")).toBe('Bearer realm="usage"');
      expect(await bearer.json()).toEqual({ error: "unauthorized", requestId: "req-9" });

      const session = apiError("unauthorized", 401);
      expect(session.headers.get("www-authenticate")).toBeNull();
    });
    const outside = apiError("not_found", 404, { details: ["x"] });
    expect(await outside.json()).toEqual({ error: "not_found", details: ["x"] });
  });
});

describe("readJsonBody", () => {
  it("parses a JSON body, dropping a leading byte order mark", async () => {
    const result = await readJsonBody(post('﻿{"a":1}'), { maxBytes: 1024, requireJsonContentType: false });
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it("refuses a body that announces itself as too large before reading it", async () => {
    const request = new Request(URL, {
      method: "POST",
      body: stream(["{}"]),
      headers: { "content-length": "999999" },
      // @ts-expect-error -- a streamed request body needs `duplex`; lib.dom's RequestInit has not caught up
      duplex: "half",
    });
    const result = await readJsonBody(request, { maxBytes: 1024, requireJsonContentType: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.response.status).toBe(413);
    expect(await result.response.json()).toEqual({ error: "payload_too_large", maxBytes: 1024 });
  });

  it("cuts off a streamed body at the cap even without a Content-Length", async () => {
    const request = new Request(URL, {
      method: "POST",
      body: stream(["x".repeat(600), "y".repeat(600)]),
      // @ts-expect-error -- see above
      duplex: "half",
    });
    const result = await readJsonBody(request, { maxBytes: 1024, requireJsonContentType: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.response.status).toBe(413);
  });

  it("answers 400 for text that is not JSON, or no body at all", async () => {
    for (const request of [post("{oops"), post(""), new Request(URL, { method: "POST" })]) {
      const result = await readJsonBody(request, { maxBytes: 1024, requireJsonContentType: false });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toEqual({ error: "invalid_json" });
    }
  });

  it("answers 400 unreadable_body when the stream breaks", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket hang up"));
      },
    });
    // @ts-expect-error -- see above
    const request = new Request(URL, { method: "POST", body: broken, duplex: "half" });
    const result = await readJsonBody(request, { maxBytes: 1024, requireJsonContentType: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ error: "unreadable_body" });
  });

  it("insists on application/json when asked to", async () => {
    const wrong = await readJsonBody(post("{}", { "content-type": "text/plain" }), { maxBytes: 1024 });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) throw new Error("unreachable");
    expect(wrong.response.status).toBe(415);

    const right = await readJsonBody(post('{"b":2}', { "content-type": "application/json; charset=utf-8" }), {
      maxBytes: 1024,
    });
    expect(right).toEqual({ ok: true, value: { b: 2 } });
  });
});

describe("requireBearer", () => {
  useRedis();
  const request = (authorization?: string) =>
    new Request(URL, { headers: authorization === undefined ? {} : { authorization } });

  it("answers 500 while the server has no usable token", async () => {
    vi.stubEnv("USAGE_API_TOKEN", "");
    expect(((await requireBearer(request("Bearer x"))) as Response).status).toBe(500);
    vi.stubEnv("USAGE_API_TOKEN", "short");
    expect(((await requireBearer(request("Bearer short"))) as Response).status).toBe(500);
  });

  it("answers 401 with a challenge for a missing or wrong token", async () => {
    vi.stubEnv("USAGE_API_TOKEN", "0123456789abcdef");
    const missing = (await requireBearer(request())) as Response;
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="usage"');
    expect(await missing.json()).toEqual({ error: "unauthorized" });
    expect(((await requireBearer(request("Bearer 0123456789abcdeX"))) as Response).status).toBe(401);
    expect(((await requireBearer(request("Basic 0123456789abcdef"))) as Response).status).toBe(401);
  });

  it("lets the master token through", async () => {
    vi.stubEnv("USAGE_API_TOKEN", " 0123456789abcdef ");
    expect(await requireBearer(request("bearer 0123456789abcdef"))).toEqual({ tokenId: "master", machineId: null });
  });

  it("authenticates a per-machine token, unbound or bound to a machine", async () => {
    vi.stubEnv("USAGE_API_TOKEN", "0123456789abcdef");
    const now = new Date("2026-09-26T00:00:00Z");
    const unbound = await createToken("laptop", null, now);
    const bound = await createToken("desktop", "mac-studio", now);
    if (!unbound.ok || !bound.ok) throw new Error("unreachable");

    expect(await requireBearer(request(`Bearer ${unbound.token}`))).toEqual({
      tokenId: unbound.id,
      machineId: null,
    });
    expect(await requireBearer(request(`Bearer ${bound.token}`))).toEqual({
      tokenId: bound.id,
      machineId: "mac-studio",
    });
  });

  it("answers 401 for a revoked per-machine token", async () => {
    vi.stubEnv("USAGE_API_TOKEN", "0123456789abcdef");
    const now = new Date("2026-09-26T00:00:00Z");
    const created = await createToken("laptop", null, now);
    if (!created.ok) throw new Error("unreachable");
    await revokeToken(created.id, now);

    const response = (await requireBearer(request(`Bearer ${created.token}`))) as Response;
    expect(response.status).toBe(401);
  });
});

describe("requireSameOrigin", () => {
  it("answers 403 for a foreign Origin only", () => {
    const foreign = new Request(URL, { method: "PUT", headers: { host: "localhost:3000", origin: "https://x.y" } });
    expect((requireSameOrigin(foreign) as Response).status).toBe(403);
    const own = new Request(URL, {
      method: "PUT",
      headers: { host: "localhost:3000", origin: "http://localhost:3000" },
    });
    expect(requireSameOrigin(own)).toBeNull();
  });
});

describe("withApiHandler", () => {
  const get = (headers: Record<string, string> = {}) => new Request(URL, { headers });

  it("echoes the request id and passes a handler's response through", async () => {
    const handler = withApiHandler("api/test", async ({ requestId, url }) =>
      json({ requestId, path: url.pathname }, 200),
    );
    const response = await handler(get({ "x-request-id": "abc-1" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("abc-1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ requestId: "abc-1", path: "/api/usage" });
  });

  it("copies immutable headers rather than failing on them", async () => {
    const handler = withApiHandler("api/test", async () => Response.redirect("http://localhost:3000/en/setup", 303));
    const response = await handler(get());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/en/setup");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("maps a store that is not configured to 503", async () => {
    const handler = withApiHandler("api/test", async () => {
      throw new StorageNotConfiguredError();
    });
    const response = await handler(get({ "x-request-id": "r" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "storage_not_configured", requestId: "r" });
  });

  it("maps the SDK's and the network's failures to 503 with Retry-After", async () => {
    for (const error of [
      new upstash.UpstashError("WRONGTYPE"),
      Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNREFUSED") }),
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    ]) {
      const handler = withApiHandler("api/test", async () => {
        throw error;
      });
      const response = await handler(get());
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("60");
      expect((await response.json()).error).toBe("storage_unavailable");
    }
  });

  it("maps anything else to 500 and logs it", async () => {
    const handler = withApiHandler("api/test", async () => {
      throw new Error("a bug");
    });
    const response = await handler(get({ "x-request-id": "r" }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error", requestId: "r" });
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) =>
      String(call[0]),
    );
    expect(logged.some((line) => line.includes("api.unhandled") && line.includes("a bug"))).toBe(true);
  });

  it("logs every request with its status and duration", async () => {
    const handler = withApiHandler("api/test", async () => json({}, 204));
    await handler(get());
    const logged = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) =>
      String(call[0]),
    );
    expect(logged.some((line) => line.includes("api.request") && line.includes("api/test"))).toBe(true);
  });

  describe("cookies", () => {
    it("reads a session cookie parsed straight from the request's own Cookie header", async () => {
      const handler = withApiHandler("api/test", async () => {
        const value = (await currentCookies()).get("usageratio_session")?.value ?? null;
        return json({ value }, 200);
      });
      const response = await handler(get({ cookie: "usageratio_session=abc123; other=1" }));
      expect(await response.json()).toEqual({ value: "abc123" });
    });

    it("answers null for a cookie that was not sent", async () => {
      const handler = withApiHandler("api/test", async () => {
        const value = (await currentCookies()).get("usageratio_session")?.value ?? null;
        return json({ value }, 200);
      });
      expect(await (await handler(get())).json()).toEqual({ value: null });
    });

    it("throws a clear error rather than silently doing nothing for set or delete", async () => {
      const setHandler = withApiHandler("api/test", async () => {
        (await currentCookies()).set("x", "1");
        return json({}, 200);
      });
      const setResponse = await setHandler(get());
      expect(setResponse.status).toBe(500);
      expect((await setResponse.json()).error).toBe("internal_error");

      const deleteHandler = withApiHandler("api/test", async () => {
        (await currentCookies()).delete("x");
        return json({}, 200);
      });
      expect((await deleteHandler(get())).status).toBe(500);
    });

    it("keeps an outer runWithRequest's jar and headers instead of a fresh one from the request", async () => {
      const jar = fakeCookieJar({ usageratio_session: "outer-value" });
      const handler = withApiHandler("api/test", async () => {
        const cookies = await currentCookies();
        // The outer jar is writable: this would throw on the request-derived read-only jar.
        cookies.set("written", "1");
        return json({ value: cookies.get("usageratio_session")?.value ?? null }, 200);
      });
      const response = await withRequest(() => handler(get({ cookie: "usageratio_session=inner-value" })), {
        cookies: jar,
        headers: { "x-outer": "1" },
      });
      expect(await response.json()).toEqual({ value: "outer-value" });
      expect(jar.sets).toEqual([{ name: "written", value: "1", options: undefined }]);
    });
  });
});
