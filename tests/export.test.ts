import { describe, expect, it } from "vitest";
import type { UsageEvent } from "@/lib/aggregate";
import {
  buildExportCsv,
  buildExportJsonPayload,
  buildExportRows,
  type ExportInput,
  exportFilename,
  parseExportQuery,
} from "@/lib/export";
import type { CycleSummary } from "@/lib/history";

const HOUR = 3_600_000;

function summary(start: number): CycleSummary {
  return {
    v: 1,
    start,
    end: start + HOUR,
    total: 100,
    limit: null,
    official: null,
    groups: { Work: 100 },
    machines: 1,
    models: {},
    subLimits: {},
    archivedAt: start,
  };
}

function input(overrides: Partial<ExportInput> = {}): ExportInput {
  return {
    generatedAtMs: Date.parse("2026-09-23T12:00:00.000Z"),
    timeZone: "Europe/Budapest",
    cycle: { startMs: 0, endMs: 7 * 24 * HOUR },
    providers: [],
    ...overrides,
  };
}

describe("parseExportQuery", () => {
  it("accepts a valid format, defaults cycle to current, and provider to null", () => {
    const result = parseExportQuery(new URLSearchParams("format=csv"));
    expect(result).toEqual({ ok: true, query: { format: "csv", cycle: "current", providerId: null } });
  });

  it("accepts an explicit cycle and provider", () => {
    const result = parseExportQuery(new URLSearchParams("format=json&cycle=previous&provider=Claude"));
    expect(result).toEqual({ ok: true, query: { format: "json", cycle: "previous", providerId: "claude" } });
  });

  it("rejects a missing or invalid format", () => {
    expect(parseExportQuery(new URLSearchParams("")).ok).toBe(false);
    expect(parseExportQuery(new URLSearchParams("format=xml")).ok).toBe(false);
  });

  it("rejects an invalid cycle or provider", () => {
    expect(parseExportQuery(new URLSearchParams("format=csv&cycle=next")).ok).toBe(false);
    expect(parseExportQuery(new URLSearchParams("format=csv&provider=!!!")).ok).toBe(false);
  });
});

describe("buildExportRows", () => {
  it("flattens every provider's events, sorted by time then provider, group and machine", () => {
    const claudeEvents: UsageEvent[] = [
      { machineId: "mac", groupId: "Work", tokens: 200, ts: 2 * HOUR },
      { machineId: "mac", groupId: "Work", tokens: 100, ts: HOUR, models: { "claude-sonnet-4-5": 100 } },
    ];
    const openaiEvents: UsageEvent[] = [
      { machineId: "pc", groupId: "Personal", tokens: 50, ts: HOUR, checkpoint: true },
    ];

    const rows = buildExportRows(
      input({
        providers: [
          { id: "claude", label: "Claude", events: claudeEvents, history: [] },
          { id: "openai", label: "OpenAI", events: openaiEvents, history: [] },
        ],
      }),
    );

    expect(rows).toEqual([
      {
        provider: "claude",
        groupId: "Work",
        machineId: "mac",
        timestamp: new Date(HOUR).toISOString(),
        tokens: 100,
        checkpoint: false,
        models: { "claude-sonnet-4-5": 100 },
      },
      {
        provider: "openai",
        groupId: "Personal",
        machineId: "pc",
        timestamp: new Date(HOUR).toISOString(),
        tokens: 50,
        checkpoint: true,
        models: null,
      },
      {
        provider: "claude",
        groupId: "Work",
        machineId: "mac",
        timestamp: new Date(2 * HOUR).toISOString(),
        tokens: 200,
        checkpoint: false,
        models: null,
      },
    ]);
  });
});

describe("buildExportCsv", () => {
  it("has the exact header row", () => {
    const csv = buildExportCsv(input());
    expect(csv).toBe("provider,groupId,machineId,timestamp,tokens,checkpoint,models\r\n");
  });

  it("quotes a comma, a double quote and a newline per RFC 4180", () => {
    const events: UsageEvent[] = [{ machineId: "mac, home", groupId: 'Work "A"', tokens: 10, ts: HOUR }];
    const csv = buildExportCsv(input({ providers: [{ id: "claude", label: "Claude", events, history: [] }] }));
    const [, row] = csv.split("\r\n");
    expect(row).toBe(`claude,"Work ""A""","mac, home",${new Date(HOUR).toISOString()},10,false,`);
  });

  it("quotes an embedded newline and encodes the model split as JSON", () => {
    const events: UsageEvent[] = [
      { machineId: "line1\nline2", groupId: "Work", tokens: 10, ts: HOUR, models: { "claude-sonnet-4-5": 10 } },
    ];
    const csv = buildExportCsv(input({ providers: [{ id: "claude", label: "Claude", events, history: [] }] }));
    expect(csv).toContain('"line1\nline2"');
    expect(csv).toContain(`"${JSON.stringify({ "claude-sonnet-4-5": 10 }).replace(/"/g, '""')}"`);
  });

  it("ends every line, including the last, with CRLF", () => {
    const events: UsageEvent[] = [{ machineId: "mac", groupId: "Work", tokens: 10, ts: HOUR }];
    const csv = buildExportCsv(input({ providers: [{ id: "claude", label: "Claude", events, history: [] }] }));
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n")).toHaveLength(3); // header, one row, and the trailing empty split after the final CRLF
  });
});

describe("buildExportJsonPayload", () => {
  it("has the documented shape, one events array per provider and its own history", () => {
    const events: UsageEvent[] = [{ machineId: "mac", groupId: "Work", tokens: 10, ts: HOUR }];
    const payload = buildExportJsonPayload(
      input({
        cycle: { startMs: 0, endMs: 7 * 24 * HOUR },
        providers: [{ id: "claude", label: "Claude", events, history: [summary(0)] }],
      }),
    );

    expect(payload.generatedAt).toBe(new Date(input().generatedAtMs).toISOString());
    expect(payload.timeZone).toBe("Europe/Budapest");
    expect(payload.cycle).toEqual({ start: new Date(0).toISOString(), end: new Date(7 * 24 * HOUR).toISOString() });
    expect(payload.providers).toEqual([
      {
        id: "claude",
        label: "Claude",
        events: [
          {
            provider: "claude",
            groupId: "Work",
            machineId: "mac",
            timestamp: new Date(HOUR).toISOString(),
            tokens: 10,
            checkpoint: false,
            models: null,
          },
        ],
        history: [summary(0)],
      },
    ]);
  });

  it("keeps one provider's events out of another's list", () => {
    const payload = buildExportJsonPayload(
      input({
        providers: [
          {
            id: "claude",
            label: "Claude",
            events: [{ machineId: "mac", groupId: "Work", tokens: 10, ts: HOUR }],
            history: [],
          },
          { id: "openai", label: "OpenAI", events: [], history: [] },
        ],
      }),
    );
    expect(payload.providers.find((p) => p.id === "claude")?.events).toHaveLength(1);
    expect(payload.providers.find((p) => p.id === "openai")?.events).toHaveLength(0);
  });
});

describe("exportFilename", () => {
  it("names the file after the provider, or 'all' without one", () => {
    expect(exportFilename("claude", "2026-09-23", "csv")).toBe("usageratio-claude-2026-09-23.csv");
    expect(exportFilename(null, "2026-09-23", "json")).toBe("usageratio-all-2026-09-23.json");
  });
});
