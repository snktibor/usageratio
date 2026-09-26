import { type CookieJar, type CookieOptions, runWithRequest } from "@/lib/request-context";

/**
 * A request scope for code that reads `currentHeaders()` / `currentCookies()`
 * (lib/request-context.ts) outside Next: the headers are whatever the test
 * says, the cookie jar records every write so the test can assert the flags.
 */

export interface FakeCookieJar extends CookieJar {
  /** Every `set` call, in order. */
  sets: { name: string; value: string; options: CookieOptions | undefined }[];
  /** Every `delete` call, in order. */
  deleted: string[];
  /** The cookies as the browser would now hold them. */
  values: Record<string, string>;
}

export function fakeCookieJar(initial: Record<string, string> = {}): FakeCookieJar {
  const jar: FakeCookieJar = {
    sets: [],
    deleted: [],
    values: { ...initial },
    get(name) {
      const value = jar.values[name];
      return value === undefined ? undefined : { value };
    },
    set(name, value, options) {
      jar.sets.push({ name, value, options });
      jar.values[name] = value;
    },
    delete(name) {
      jar.deleted.push(name);
      delete jar.values[name];
    },
  };
  return jar;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  cookies?: CookieJar;
  requestId?: string;
  route?: string;
}

/** Runs `fn` inside a request scope; deferred work runs inline so the test can await it. */
export function withRequest<T>(fn: () => Promise<T> | T, options: RequestOptions = {}): Promise<T> {
  return runWithRequest(
    {
      requestId: options.requestId ?? "test",
      route: options.route ?? "test",
      headers: new Headers(options.headers ?? {}),
      cookies: options.cookies ?? fakeCookieJar(),
      deferInline: true,
    },
    fn,
  );
}
