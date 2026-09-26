import { currentRequestId } from "@/lib/request-context";

/**
 * Structured logging: one JSON object per line in production (what Vercel's
 * log drains and `vercel logs` index), a readable line in development. Every
 * line carries the current request id when there is one (lib/request-context.ts),
 * and any field whose name smells like a secret is redacted before it is written.
 */

export type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Fields = Record<string, unknown>;

export interface Logger {
  readonly level: Level;
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** A logger whose every line also carries `bindings`. */
  child(bindings: Fields): Logger;
}

export interface LoggerOptions {
  level?: Level;
  format?: "json" | "pretty";
  /** Where the lines go; the console by default. */
  write?: (line: string, level: Level) => void;
}

const SECRET_KEY = /token|pin|secret|authorization|cookie|password/i;

/** A copy of `value` with every secret-looking field replaced; safe on cycles. */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (value instanceof Date) return value.toISOString();
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(item, seen);
  }
  return copy;
}

/** An error as plain fields: the message and stack, plus the codes Node and Next attach. */
export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const { code, digest, cause } = error as Error & { code?: unknown; digest?: unknown };
    return {
      name: error.name,
      message: error.message,
      ...(error.stack && { stack: error.stack }),
      ...((typeof code === "string" || typeof code === "number") && { code }),
      ...(typeof digest === "string" && { digest }),
      ...(cause instanceof Error && { cause: `${cause.name}: ${cause.message}` }),
    };
  }
  return { message: String(error) };
}

function isLevel(value: string | undefined): value is Level {
  return value !== undefined && Object.hasOwn(LEVELS, value);
}

function defaultLevel(): Level {
  const configured = process.env.LOG_LEVEL?.trim().toLowerCase();
  return isLevel(configured) ? configured : "info";
}

function defaultFormat(): "json" | "pretty" {
  const configured = process.env.LOG_FORMAT?.trim().toLowerCase();
  if (configured === "json" || configured === "pretty") return configured;
  return process.env.NODE_ENV === "production" ? "json" : "pretty";
}

function writeToConsole(line: string, level: Level): void {
  if (level === "error") console.error(line);
  else console.log(line);
}

function formatPretty(record: Record<string, unknown>): string {
  const { t, level, msg, ...rest } = record;
  const time = typeof t === "string" ? t.slice(11, 23) : "";
  const tag = String(level).toUpperCase().padEnd(5);
  const fields = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
  return `${time} ${tag} ${msg}${fields}`;
}

function serialize(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    // A value JSON cannot take (a BigInt, say): keep the line, drop the fields.
    return JSON.stringify({ t: record.t, level: record.level, msg: record.msg, fields: "[unserializable]" });
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? defaultLevel();
  const format = options.format ?? defaultFormat();
  const write = options.write ?? writeToConsole;
  const threshold = LEVELS[level];

  function make(bindings: Fields): Logger {
    const emit = (lineLevel: Level, msg: string, fields?: Fields): void => {
      if (LEVELS[lineLevel] < threshold) return;
      const requestId = currentRequestId();
      const merged: Record<string, unknown> = { ...bindings, ...fields };
      if (requestId && merged.requestId === undefined) merged.requestId = requestId;
      if (merged.err !== undefined) merged.err = errorFields(merged.err);
      const record = { t: new Date().toISOString(), level: lineLevel, msg, ...(redact(merged) as Fields) };
      write(format === "json" ? serialize(record) : formatPretty(record), lineLevel);
    };
    return {
      level,
      debug: (msg, fields) => emit("debug", msg, fields),
      info: (msg, fields) => emit("info", msg, fields),
      warn: (msg, fields) => emit("warn", msg, fields),
      error: (msg, fields) => emit("error", msg, fields),
      child: (more) => make({ ...bindings, ...more }),
    };
  }

  return make({});
}

/** The app's logger. Level from LOG_LEVEL (default info); JSON in production or with LOG_FORMAT=json. */
export const log: Logger = createLogger();
