/** A validated usage report, as sent by the client scripts. */
export interface UsageReport {
  machineId: string;
  groupId: string;
  tokens: number;
  /** Event time in epoch milliseconds. */
  timestampMs: number;
  /** Event time normalized to UTC ISO 8601. */
  timestamp: string;
}

export type ParseResult =
  | { ok: true; report: UsageReport }
  | { ok: false; errors: string[] };

export interface ParseOptions {
  now: Date;
  maxClockSkewMinutes: number;
  retentionDays: number;
}

const MAX_ID_LENGTH = 64;
// Letters and digits of any script, plus space . _ - (the ids end up in Redis key names).
const ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

function parseId(value: unknown, field: string, errors: string[]): string {
  if (typeof value !== "string") {
    errors.push(`${field} must be a string`);
    return "";
  }
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_ID_LENGTH) {
    errors.push(`${field} must be 1-${MAX_ID_LENGTH} characters long`);
  } else if (!ID_PATTERN.test(id)) {
    errors.push(`${field} may only contain letters, digits, spaces, dots, dashes and underscores`);
  }
  return id;
}

/** Strict ISO 8601 date-time with a zone designator → epoch ms, or null. */
export function parseIsoTimestamp(value: string): number | null {
  const match = ISO_PATTERN.exec(value);
  if (!match) return null;

  const [, y, mo, d, h, mi, s = "0", fraction = "", zone = "Z"] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const millisecond = Number(fraction.padEnd(3, "0").slice(0, 3));
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMins = Number(zone.slice(4, 6));
    if (offsetHours > 14 || offsetMins > 59) return null;
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }

  const wallClock = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  // Date.UTC silently rolls "Feb 30" over into March; reject instead.
  if (new Date(wallClock).getUTCDate() !== day) return null;
  return wallClock - offsetMinutes * 60_000;
}

/** Validates the JSON body of POST /api/usage. */
export function parseUsageReport(input: unknown, options: ParseOptions): ParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const body = input as Record<string, unknown>;
  const errors: string[] = [];

  const machineId = parseId(body.machineId, "machineId", errors);
  const groupId = parseId(body.groupId, "groupId", errors);

  const tokens = body.tokens;
  if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0) {
    errors.push("tokens must be a non-negative integer (a JSON number)");
  }

  let timestampMs: number | null = null;
  if (typeof body.timestamp === "string") timestampMs = parseIsoTimestamp(body.timestamp.trim());
  if (timestampMs === null) {
    errors.push('timestamp must be an ISO 8601 date-time with a zone, e.g. "2026-09-21T10:00:00Z"');
  } else {
    const nowMs = options.now.getTime();
    if (timestampMs > nowMs + options.maxClockSkewMinutes * 60_000) {
      errors.push(
        `timestamp is more than ${options.maxClockSkewMinutes} minutes in the future (check the machine's clock)`,
      );
    } else if (timestampMs < nowMs - options.retentionDays * 86_400_000) {
      errors.push(`timestamp is older than the ${options.retentionDays}-day retention window`);
    }
  }

  if (errors.length > 0 || timestampMs === null) return { ok: false, errors };
  return {
    ok: true,
    report: {
      machineId,
      groupId,
      tokens: tokens as number,
      timestampMs,
      timestamp: new Date(timestampMs).toISOString(),
    },
  };
}
