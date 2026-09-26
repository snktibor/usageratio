import { describe, expect, it } from "vitest";
import type { UsageEvent } from "@/lib/aggregate";
import { getConfig } from "@/lib/config";
import { getCycle } from "@/lib/cycle";
import { buildProviderDashboards, type KnownMachine } from "@/lib/dashboard";
import { reportCheckpoints } from "@/lib/days";
import {
  buildDemoDataset,
  DEMO_GROUPS,
  DEMO_MACHINES,
  DEMO_PROVIDERS,
  DEMO_TARGETS,
  type DemoDataset,
} from "@/lib/demo/dataset";
import { type KnownGroup, parseSettingsUpdate, resolveConfig, serializeSettings } from "@/lib/settings";
import { parseUsageReport, type UsageReport } from "@/lib/validation";

// Wednesday 14:00 in Budapest: the cycle started Monday 00:00, 62 hours ago.
const NOW = new Date("2026-09-23T12:00:00Z");
const HOUR = 3_600_000;

const dataset = buildDemoDataset(NOW);

function parseAll(set: DemoDataset): UsageReport[] {
  const problems: string[] = [];
  const reports: UsageReport[] = [];
  for (const report of set.reports) {
    const parsed = parseUsageReport(report.body, {
      now: new Date(report.timestampMs),
      maxClockSkewMinutes: 10,
      retentionDays: 70,
      timeZone: set.timeZone,
    });
    if (parsed.ok) reports.push(parsed.report);
    else
      problems.push(`${report.machineId} @ ${new Date(report.timestampMs).toISOString()}: ${parsed.errors.join("; ")}`);
  }
  expect(problems).toEqual([]);
  return reports;
}

/** The store's reading of the reports: one event per provider, plus the checkpoints of the splits by day. */
function eventsByProvider(set: DemoDataset, reports: UsageReport[]): Record<string, UsageEvent[]> {
  const events: Record<string, UsageEvent[]> = {};
  for (const report of reports) {
    const cycleStart = getCycle(new Date(report.timestampMs), set.reset).start.getTime();
    for (const [providerId, tokens] of Object.entries(report.providers)) {
      (events[providerId] ??= []).push({
        machineId: report.machineId,
        groupId: report.groupId,
        tokens,
        ts: report.timestampMs,
        ...(report.models[providerId] && { models: report.models[providerId] }),
      });
    }
    for (const checkpoint of reportCheckpoints(report, set.timeZone, cycleStart)) {
      (events[checkpoint.providerId] ??= []).push({
        machineId: report.machineId,
        groupId: report.groupId,
        tokens: checkpoint.tokens,
        ts: checkpoint.ts,
        ...(checkpoint.models && { models: checkpoint.models }),
        checkpoint: true,
      });
    }
  }
  return events;
}

/** What snapshot mode measures for a provider this cycle: every machine's last reading. */
function measuredThisCycle(set: DemoDataset, reports: UsageReport[], providerId: string): number {
  const latest = new Map<string, number>();
  for (const report of reports) {
    if (report.timestampMs < set.cycles.current.start.getTime()) continue;
    const tokens = report.providers[providerId];
    if (tokens !== undefined) latest.set(report.machineId, tokens);
  }
  return [...latest.values()].reduce((sum, tokens) => sum + tokens, 0);
}

describe("buildDemoDataset", () => {
  const reports = parseAll(dataset);

  it("is deterministic", () => {
    expect(JSON.stringify(buildDemoDataset(NOW))).toBe(JSON.stringify(dataset));
    expect(JSON.stringify(buildDemoDataset(NOW, { seed: 7 }))).not.toBe(JSON.stringify(dataset));
  });

  it("stays inside the ingest limits", () => {
    expect(dataset.reports.length).toBeGreaterThan(100);
    expect(dataset.reports.length).toBeLessThanOrEqual(450);
    for (const report of dataset.reports) {
      expect(Buffer.byteLength(JSON.stringify(report.body)), `${report.machineId} body`).toBeLessThan(60_000);
    }
  });

  it("covers every machine, group and provider, oldest report first", () => {
    const machines = new Set(dataset.reports.map((report) => report.machineId));
    expect([...machines].sort()).toEqual(DEMO_MACHINES.map((machine) => machine.id).sort());
    const groups = new Set(reports.map((report) => report.groupId));
    expect([...groups].sort()).toEqual(DEMO_GROUPS.map((group) => group.id).sort());
    const providers = new Set(reports.flatMap((report) => Object.keys(report.providers)));
    expect([...providers].sort()).toEqual(DEMO_PROVIDERS.map((provider) => provider.id).sort());
    for (let i = 1; i < dataset.reports.length; i += 1) {
      expect(dataset.reports[i]!.timestampMs).toBeGreaterThanOrEqual(dataset.reports[i - 1]!.timestampMs);
    }
  });

  it("sends cycle-to-date snapshots that only ever grow within a cycle", () => {
    const byMachine = new Map<string, UsageReport[]>();
    for (const report of reports) byMachine.set(report.machineId, [...(byMachine.get(report.machineId) ?? []), report]);
    for (const [machineId, list] of byMachine) {
      for (let i = 1; i < list.length; i += 1) {
        const previous = list[i - 1]!;
        const report = list[i]!;
        const sameCycle =
          getCycle(new Date(previous.timestampMs), dataset.reset).start.getTime() ===
          getCycle(new Date(report.timestampMs), dataset.reset).start.getTime();
        if (!sameCycle) continue;
        for (const [providerId, tokens] of Object.entries(report.providers)) {
          expect(tokens, `${machineId} ${providerId} @ ${report.timestamp}`).toBeGreaterThanOrEqual(
            previous.providers[providerId] ?? 0,
          );
        }
      }
    }
  });

  it("splits every report by day, with Claude's days by hour, and the parts add up", () => {
    for (const report of reports) {
      if (Object.values(report.providers).every((tokens) => tokens === 0)) continue;
      expect(report.days.length, `${report.machineId} @ ${report.timestamp}`).toBeGreaterThan(0);
      const totals: Record<string, number> = {};
      for (const day of report.days) {
        for (const [providerId, tokens] of Object.entries(day.providers)) {
          totals[providerId] = (totals[providerId] ?? 0) + tokens;
          if (providerId === "claude") {
            const hours = day.hours.claude ?? [];
            expect(hours.length, `${report.machineId} ${day.date} claude hours`).toBeGreaterThan(0);
            expect(hours.reduce((sum, hour) => sum + hour.tokens, 0)).toBe(tokens);
          }
        }
      }
      for (const [providerId, tokens] of Object.entries(report.providers)) {
        expect(totals[providerId] ?? 0, `${report.machineId} ${providerId} days`).toBe(tokens);
        const split = Object.values(report.models[providerId] ?? {}).reduce((sum, amount) => sum + amount, 0);
        expect(split, `${report.machineId} ${providerId} models`).toBe(tokens);
      }
    }
  });

  it("lands the reference provider near its target this cycle, and the rest under their limits", () => {
    const reference = DEMO_PROVIDERS.find((provider) => provider.id === DEMO_TARGETS.providerId)!;
    const share = measuredThisCycle(dataset, reports, reference.id) / reference.limit;
    expect(share).toBeGreaterThan(0.55);
    expect(share).toBeLessThan(0.75);
    for (const provider of DEMO_PROVIDERS) {
      const measured = measuredThisCycle(dataset, reports, provider.id);
      expect(measured, provider.id).toBeGreaterThan(0);
      expect(measured / provider.limit, provider.id).toBeLessThan(1);
    }
  });

  it("gives Claude and OpenAI a plausible cost estimate, and leaves the other providers without one", () => {
    const withCost = new Set(
      reports.flatMap((report) => Object.keys(report.costs)).filter((providerId) => providerId !== ""),
    );
    expect(withCost).toEqual(new Set(["claude", "openai"]));
    for (const report of reports) {
      for (const [providerId, cost] of Object.entries(report.costs)) {
        expect(cost, `${report.machineId} ${providerId} cost`).toBeGreaterThan(0);
        const modelSum = Object.values(report.modelCosts[providerId] ?? {}).reduce((sum, amount) => sum + amount, 0);
        expect(modelSum, `${report.machineId} ${providerId} modelCosts`).toBeCloseTo(cost, 4);
      }
    }
  });

  it("gives Claude and OpenAI's archived cycles a cost too, and leaves the others without one", () => {
    for (const entry of dataset.history) {
      if (entry.providerId === "claude" || entry.providerId === "openai") {
        expect(entry.summary.cost, `${entry.providerId} @ ${entry.summary.start}`).toBeGreaterThan(0);
      } else {
        expect(entry.summary.cost, `${entry.providerId} @ ${entry.summary.start}`).toBeUndefined();
      }
    }
  });

  it("gives every hourly machine a complete previous cycle", () => {
    const previousEnd = dataset.cycles.current.start.getTime();
    const stillReporting = DEMO_MACHINES.filter(
      (candidate) => candidate.mode === "auto" && candidate.lastReportOffsetMs === null,
    );
    expect(stillReporting.length).toBeGreaterThan(0);
    for (const machine of stillReporting) {
      const last = reports
        .filter((report) => report.machineId === machine.id && report.timestampMs < previousEnd)
        .at(-1);
      expect(last, machine.id).toBeDefined();
      // The last snapshot of the previous cycle was sent on its final evening, or Friday's for a weekday-only machine.
      expect(previousEnd - last!.timestampMs, machine.id).toBeLessThanOrEqual(3 * 24 * HOUR);
      expect(
        Object.values(last!.providers).some((tokens) => tokens > 0),
        machine.id,
      ).toBe(true);
    }
  });

  it("validates as a settings update and carries the official figures of this cycle", () => {
    const body = {
      ...dataset.settings.settings,
      groups: dataset.settings.groups,
      removedGroups: dataset.settings.removedGroups,
    };
    const parsed = parseSettingsUpdate(body);
    expect(parsed.ok, parsed.ok ? "" : parsed.errors.join("; ")).toBe(true);
    if (parsed.ok) expect(parsed.update).toEqual(dataset.settings);
    for (const entry of dataset.official) {
      expect(entry.cycleStartMs).toBe(dataset.cycles.current.start.getTime());
      expect(entry.enteredAtMs).toBeLessThan(NOW.getTime());
    }
  });

  it("builds a dashboard with three groups and the intended machine health", () => {
    const providerIds = DEMO_PROVIDERS.map((provider) => provider.id);
    const config = resolveConfig(
      getConfig({ RESET_TIMEZONE: dataset.timeZone }),
      serializeSettings(dataset.settings.settings, NOW),
      providerIds,
    );
    const groups: KnownGroup[] = DEMO_GROUPS.map((group, index) => ({
      groupId: group.id,
      color: group.color,
      firstSeenAt: index,
      hasReports: true,
    }));
    const machines: (KnownMachine & { providerId: string })[] = [];
    for (const report of reports) {
      for (const [providerId, tokens] of Object.entries(report.providers)) {
        const known = machines.find(
          (machine) => machine.providerId === providerId && machine.machineId === report.machineId,
        );
        if (known) {
          known.lastSeenAt = report.timestampMs;
          known.lastTokens = tokens;
        } else {
          machines.push({
            providerId,
            machineId: report.machineId,
            groupId: report.groupId,
            lastSeenAt: report.timestampMs,
            lastTokens: tokens,
          });
        }
      }
    }
    const dashboards = buildProviderDashboards(NOW, config, providerIds, {
      eventsByProvider: eventsByProvider(dataset, reports),
      groups,
      machines,
    });

    const groupIds = new Set(dashboards.flatMap((provider) => provider.dashboard.groups.map((group) => group.groupId)));
    expect([...groupIds].sort()).toEqual(["Lab", "Personal", "Work"]);

    const claude = dashboards.find((provider) => provider.id === "claude")!;
    expect(claude.dashboard.groups.map((group) => group.groupId).sort()).toEqual(["Personal", "Work"]);
    expect(claude.dashboard.total).toBe(measuredThisCycle(dataset, reports, "claude"));
    expect(claude.dashboard.machines.find((machine) => machine.machineId === "old-laptop")?.health).toBe("inactive");
    expect(claude.dashboard.machines.find((machine) => machine.machineId === "mac-studio")?.health).toBe("active");
    expect(claude.dashboard.subLimits[0]?.total).toBeGreaterThan(0);

    const deepseek = dashboards.find((provider) => provider.id === "deepseek")!;
    expect(deepseek.dashboard.machines.find((machine) => machine.machineId === "build-box")?.health).toBe("late");

    // Lab's OpenAI usage does not count: build-box is off the OpenAI dashboard.
    const openai = dashboards.find((provider) => provider.id === "openai")!;
    expect(openai.dashboard.machines.map((machine) => machine.machineId)).not.toContain("build-box");
  });
});
