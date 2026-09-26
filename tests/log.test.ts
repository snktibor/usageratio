import { describe, expect, it } from "vitest";
import { createLogger, errorFields, type Level, redact } from "@/lib/log";
import { runWithRequest } from "@/lib/request-context";

function capture(options: { level?: Level; format?: "json" | "pretty" } = {}) {
  const lines: { line: string; level: Level }[] = [];
  const logger = createLogger({ ...options, write: (line, level) => lines.push({ line, level }) });
  return { logger, lines, records: () => lines.map(({ line }) => JSON.parse(line) as Record<string, unknown>) };
}

describe("createLogger", () => {
  it("writes one JSON object per line with time, level, message and fields", () => {
    const { logger, lines, records } = capture({ format: "json" });
    logger.info("auth.login_ok", { deviceKnown: true, attempts: 2 });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("info");
    const [record] = records();
    expect(record).toMatchObject({ level: "info", msg: "auth.login_ok", deviceKnown: true, attempts: 2 });
    expect(typeof record!.t).toBe("string");
    expect(new Date(record!.t as string).toISOString()).toBe(record!.t);
    expect(record).not.toHaveProperty("requestId");
  });

  it("drops lines under the configured level", () => {
    const { logger, lines } = capture({ level: "warn", format: "json" });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(lines.map(({ level }) => level)).toEqual(["warn", "error"]);
    expect(logger.level).toBe("warn");
  });

  it("redacts secret-looking fields, also nested ones, and survives a cycle", () => {
    const { logger, records } = capture({ format: "json" });
    const cyclic: Record<string, unknown> = { fine: 1 };
    cyclic.self = cyclic;
    logger.info("x", {
      token: "abc",
      nested: { password: "p", Authorization: "Bearer x", ok: "kept", cookie: "c" },
      list: [{ apiToken: "t" }],
      pin: "12345",
      cyclic,
    });
    const [record] = records();
    expect(record).toMatchObject({
      token: "[redacted]",
      nested: { password: "[redacted]", Authorization: "[redacted]", ok: "kept", cookie: "[redacted]" },
      list: [{ apiToken: "[redacted]" }],
      pin: "[redacted]",
      cyclic: { fine: 1, self: "[circular]" },
    });
  });

  it("turns an `err` field into name, message, stack and codes", () => {
    const { logger, records } = capture({ format: "json" });
    const error = Object.assign(new Error("boom"), { code: "ECONNREFUSED", digest: "123" });
    logger.error("storage.unavailable", { err: error });
    const [record] = records();
    expect(record!.err).toMatchObject({ name: "Error", message: "boom", code: "ECONNREFUSED", digest: "123" });
    expect((record!.err as { stack: string }).stack).toContain("boom");
    expect(errorFields("plain string")).toEqual({ message: "plain string" });
  });

  it("formats a readable line in pretty mode", () => {
    const { logger, lines } = capture({ format: "pretty" });
    logger.warn("auth.login_failed", { attemptsLeft: 3 });
    expect(lines[0]!.line).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} WARN {2}auth\.login_failed \{"attemptsLeft":3\}$/);
    logger.info("bare");
    expect(lines[1]!.line).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} INFO {2}bare$/);
  });

  it("carries the request id of the request being served, and child bindings", async () => {
    const { logger, records } = capture({ format: "json" });
    const child = logger.child({ route: "api/usage" });
    await runWithRequest({ requestId: "req-1", route: "api/usage" }, async () => {
      child.info("api.request", { status: 200 });
    });
    child.info("outside");
    const [inside, outside] = records();
    expect(inside).toMatchObject({ requestId: "req-1", route: "api/usage", status: 200 });
    expect(outside).toMatchObject({ route: "api/usage" });
    expect(outside).not.toHaveProperty("requestId");
  });

  it("does not let an explicit requestId field be overwritten", async () => {
    const { logger, records } = capture({ format: "json" });
    await runWithRequest({ requestId: "req-1", route: "x" }, async () => {
      logger.info("y", { requestId: "explicit" });
    });
    expect(records()[0]!.requestId).toBe("explicit");
  });
});

describe("redact", () => {
  it("leaves primitives and dates alone", () => {
    expect(redact(5)).toBe(5);
    expect(redact("token")).toBe("token");
    expect(redact(new Date("2026-09-26T00:00:00Z"))).toBe("2026-09-26T00:00:00.000Z");
  });
});
