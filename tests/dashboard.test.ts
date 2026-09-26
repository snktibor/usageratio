import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { buildDashboard, buildProviderDashboards, type StoreSnapshot } from "@/lib/dashboard";
import { type KnownGroup, NEUTRAL_COLOR, PRESET_COLORS } from "@/lib/settings";

const HOUR = 3_600_000;
// The token limits are off by default; most of these cases are about measuring against one.
// The zone is fixed explicitly: these fixtures are written in Budapest time, independent of
// DEFAULT_RESET's own (deploy-time) default.
const config = {
  ...getConfig({}),
  useTokenLimits: true,
  limit: 500_000,
  tokenMode: "delta" as const,
  reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" },
};

// Wednesday 12:00 Budapest time; the cycle started Monday 00:00 (= Sunday 22:00 UTC), 60 h ago.
const NOW = new Date("2026-09-23T10:00:00Z");
const CYCLE_START = Date.parse("2026-09-20T22:00:00Z");

function snapshot(partial: Partial<StoreSnapshot>): StoreSnapshot {
  return { events: [], groups: [], machines: [], ...partial };
}

function report(machineId: string, groupId: string, tokens: number, hoursIntoCycle: number) {
  return { machineId, groupId, tokens, ts: CYCLE_START + hoursIntoCycle * HOUR };
}

/** `color` null: an index entry from before groups had colours. */
function group(groupId: string, firstSeenAt: number, color: string | null = null): KnownGroup {
  return { groupId, firstSeenAt, color, hasReports: true };
}

describe("buildDashboard — quota and pace", () => {
  it("measures usage against the weekly limit", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({
        events: [report("win-1", "Work", 150_000, 10), report("mac", "Personal", 100_000, 20)],
      }),
    );
    expect(model.total).toBe(250_000);
    expect(model.quota?.usedFraction).toBe(0.5);
    expect(model.quota?.remaining).toBe(250_000);
    expect(model.quota?.overage).toBe(0);
    expect(model.cycle.elapsedFraction).toBeCloseTo(60 / 168, 10);
  });

  it("warns when the current pace would exhaust the limit before the reset", () => {
    const model = buildDashboard(NOW, config, snapshot({ events: [report("win-1", "Work", 250_000, 10)] }));
    expect(model.quota?.pace.projectedTotal).toBeCloseTo(700_000, 5);
    expect(model.quota?.status).toBe("warning");
    // Half the limit took 60 h, so the whole limit lasts 120 h.
    expect(model.quota?.pace.runOutAt).toBe(CYCLE_START + 120 * HOUR);
  });

  it("is fine when the pace fits the limit", () => {
    const model = buildDashboard(NOW, config, snapshot({ events: [report("win-1", "Work", 100_000, 10)] }));
    expect(model.quota?.status).toBe("good");
    expect(model.quota?.pace.projectedTotal).toBeCloseTo(280_000, 5);
    expect(model.quota?.pace.runOutAt).toBeNull();
  });

  it("warns above 80% even if the pace is fine", () => {
    const lateInCycle = new Date(CYCLE_START + 160 * HOUR);
    const model = buildDashboard(lateInCycle, config, snapshot({ events: [report("win-1", "Work", 410_000, 10)] }));
    expect(model.quota?.pace.projectedTotal).toBeLessThan(500_000);
    expect(model.quota?.status).toBe("warning");
  });

  it("is critical once the limit is used up", () => {
    const model = buildDashboard(NOW, config, snapshot({ events: [report("win-1", "Work", 560_000, 10)] }));
    expect(model.quota?.status).toBe("critical");
    expect(model.quota?.remaining).toBe(0);
    expect(model.quota?.overage).toBe(60_000);
    expect(model.quota?.pace.runOutAt).toBeNull();
  });

  it("does not extrapolate during the first day of a cycle", () => {
    const early = new Date(CYCLE_START + 5 * HOUR);
    const model = buildDashboard(early, config, snapshot({ events: [report("win-1", "Work", 60_000, 2)] }));
    expect(model.quota?.pace.projectedTotal).toBeNull();
    expect(model.quota?.pace.earlyBurn).toBe(false);
    expect(model.quota?.status).toBe("good");
  });

  it("still warns on the first day when usage is far beyond a day's fair share", () => {
    const early = new Date(CYCLE_START + 13 * HOUR);
    // 40% gone in 13 hours; a whole day's even share is only 1/7 ≈ 14%.
    const model = buildDashboard(early, config, snapshot({ events: [report("win-1", "Work", 200_000, 2)] }));
    expect(model.quota?.pace.projectedTotal).toBeNull();
    expect(model.quota?.pace.earlyBurn).toBe(true);
    expect(model.quota?.pace.dailyShare).toBeCloseTo(1 / 7, 10);
    expect(model.quota?.status).toBe("warning");
  });

  it("stops flagging an early burn once a real projection is available", () => {
    const model = buildDashboard(NOW, config, snapshot({ events: [report("win-1", "Work", 200_000, 2)] }));
    expect(model.quota?.pace.projectedTotal).not.toBeNull();
    expect(model.quota?.pace.earlyBurn).toBe(false);
  });

  it("ignores reports from before the current cycle, but totals the previous one", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({
        events: [
          report("win-1", "Work", 40_000, -30),
          report("mac", "Personal", 2_000, -100),
          report("win-1", "Work", 7_000, 3),
        ],
      }),
    );
    expect(model.total).toBe(7_000);
    expect(model.previousTotal).toBe(42_000);
  });

  it("carries the remaining-tokens switch to the page, without touching the figures", () => {
    const events = [report("win-1", "Work", 150_000, 10)];
    const shown = buildDashboard(NOW, config, snapshot({ events }));
    const hidden = buildDashboard(NOW, { ...config, showRemaining: false }, snapshot({ events }));
    expect(shown.showRemaining).toBe(true);
    expect(hidden.showRemaining).toBe(false);
    // Display only: everything else is the same model.
    expect(hidden).toEqual({ ...shown, showRemaining: false });
    expect(hidden.quota?.remaining).toBe(350_000);
  });

  it("lays the cycle out as seven day segments from 0 to 1", () => {
    const model = buildDashboard(NOW, config, snapshot({}));
    expect(model.cycle.segments).toHaveLength(7);
    expect(model.cycle.segments[0]?.startFraction).toBe(0);
    expect(model.cycle.segments[6]?.endFraction).toBe(1);
    expect(model.cycle.segments.map((s) => s.weekday)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });
});

describe("buildDashboard — without token limits", () => {
  const events = [report("win-1", "Work", 150_000, 10), report("mac", "Personal", 50_000, 20)];
  const known = [{ machineId: "old", groupId: "Work", lastSeenAt: NOW.getTime() - 48 * HOUR, lastTokens: 0 }];
  const bare = buildDashboard(NOW, { ...config, useTokenLimits: false }, snapshot({ events, machines: known }));

  it("is the default", () => {
    expect(getConfig({}).useTokenLimits).toBe(false);
    expect(buildDashboard(NOW, getConfig({}), snapshot({ events })).quota).toBeNull();
  });

  it("measures the tokens and their proportions, but nothing against a limit", () => {
    expect(bare.total).toBe(200_000);
    expect(bare.quota).toBeNull();
    expect(bare.groups.map((g) => [g.groupId, g.tokens, g.share, g.limitShare])).toEqual([
      ["Work", 150_000, 0.75, null],
      ["Personal", 50_000, 0.25, null],
    ]);
    expect(bare.machines.map((m) => [m.machineId, m.share, m.limitShare])).toEqual([
      ["win-1", 0.75, null],
      ["mac", 0.25, null],
      ["old", 0, null],
    ]);
  });

  it("is otherwise the model the limits would give", () => {
    const limited = buildDashboard(NOW, config, snapshot({ events, machines: known }));
    expect(limited.quota).not.toBeNull();
    expect(bare).toEqual({
      ...limited,
      quota: null,
      groups: limited.groups.map((g) => ({ ...g, limitShare: null })),
      machines: limited.machines.map((m) => ({ ...m, limitShare: null })),
    });
  });
});

describe("buildDashboard — groups", () => {
  it("shows every group in the colour saved for it", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({
        events: [report("mac", "Personal", 900, 5), report("win-1", "Work", 100, 5)],
        groups: [group("Work", 100, "#ff00aa"), group("Personal", 200, "#00ccff")],
      }),
    );
    expect(model.groups.map((g) => [g.groupId, g.color])).toEqual([
      ["Personal", "#00ccff"],
      ["Work", "#ff00aa"],
    ]);
    expect(model.groups[0]?.share).toBe(0.9);
    expect(model.groups[0]?.limitShare).toBe(900 / 500_000);
  });

  it("gives groups without a saved colour a preset by first appearance, not by rank", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({
        events: [report("mac", "Personal", 900, 5), report("win-1", "Work", 100, 5)],
        groups: [group("Work", 100), group("Personal", 200)],
      }),
    );
    expect(model.groups.map((g) => [g.groupId, g.color])).toEqual([
      ["Personal", PRESET_COLORS[1]],
      ["Work", PRESET_COLORS[0]],
    ]);
  });

  it("never hands a preset out twice, and falls back to the neutral after the eighth", () => {
    const groups = Array.from({ length: 10 }, (_, i) => group(`g${i}`, i, i === 0 ? PRESET_COLORS[3] : null));
    const model = buildDashboard(
      NOW,
      config,
      snapshot({ groups, events: groups.map((g) => report("m", g.groupId, 10, 1)) }),
    );
    const colors = Object.fromEntries(model.groups.map((g) => [g.groupId, g.color]));
    expect(colors.g0).toBe(PRESET_COLORS[3]);
    // g1…g7 take the seven presets g0 left free, in order.
    expect(colors.g1).toBe(PRESET_COLORS[0]);
    expect(colors.g3).toBe(PRESET_COLORS[2]);
    expect(colors.g4).toBe(PRESET_COLORS[4]);
    expect(colors.g7).toBe(PRESET_COLORS[7]);
    expect(colors.g8).toBe(NEUTRAL_COLOR);
    expect(colors.g9).toBe(NEUTRAL_COLOR);
    expect(new Set(Object.values(colors)).size).toBe(9);
  });

  it("colours a group that only occurs in reports, not in the index", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({ events: [report("mac", "Stray", 10, 1)], groups: [group("Work", 1)] }),
    );
    expect(model.groups.map((g) => [g.groupId, g.color])).toEqual([["Stray", PRESET_COLORS[1]]]);
  });
});

describe("buildDashboard — monthly budget", () => {
  const monthly = { ...config, reset: { ...config.reset, period: "monthly" as const } };
  // September 1 00:00 Budapest time; NOW is 22.5 days (540 h) into a 30-day month.
  const MONTH_START = Date.parse("2026-08-31T22:00:00Z");

  it("measures the month since its reset day, against the same limit", () => {
    const model = buildDashboard(
      NOW,
      monthly,
      snapshot({
        events: [
          { machineId: "mac", groupId: "Personal", tokens: 300_000, ts: MONTH_START + 100 * HOUR },
          { machineId: "mac", groupId: "Personal", tokens: 9_000, ts: MONTH_START - 100 * HOUR },
        ],
      }),
    );
    expect(model.period).toBe("monthly");
    expect(model.total).toBe(300_000);
    expect(model.previousTotal).toBe(9_000);
    expect(model.cycle.startMs).toBe(MONTH_START);
    expect(model.cycle.elapsedFraction).toBeCloseTo(540 / 720, 10);
    expect(model.quota?.pace.projectedTotal).toBeCloseTo(400_000, 5);
    expect(model.quota?.status).toBe("good");
  });

  it("takes one day of the month as the daily share", () => {
    const early = new Date(MONTH_START + 20 * HOUR);
    const model = buildDashboard(
      early,
      monthly,
      // 8% gone before the first day is over; an even day is 1/30 ≈ 3.3%.
      snapshot({ events: [{ machineId: "mac", groupId: "Personal", tokens: 40_000, ts: MONTH_START + HOUR }] }),
    );
    expect(model.quota?.pace.dailyShare).toBeCloseTo(1 / 30, 10);
    expect(model.quota?.pace.projectedTotal).toBeNull();
    expect(model.quota?.pace.earlyBurn).toBe(true);
    expect(model.quota?.status).toBe("warning");
  });

  it("lays the cycle out as the days of the month", () => {
    const model = buildDashboard(NOW, monthly, snapshot({}));
    expect(model.cycle.segments).toHaveLength(30);
    expect(model.cycle.segments[0]?.monthDay).toBe(1);
    expect(model.cycle.segments[29]?.monthDay).toBe(30);
    expect(model.cycle.segments[29]?.endFraction).toBe(1);
  });
});

describe("buildDashboard — machines", () => {
  const known = [
    { machineId: "mac", groupId: "Personal", lastSeenAt: NOW.getTime() - 0.5 * HOUR, lastTokens: 10 },
    { machineId: "win-1", groupId: "Work", lastSeenAt: NOW.getTime() - 5 * HOUR, lastTokens: 0 },
    { machineId: "win-2", groupId: "Work", lastSeenAt: NOW.getTime() - 9 * 24 * HOUR, lastTokens: 0 },
    { machineId: "retired", groupId: "Work", lastSeenAt: NOW.getTime() - 60 * 24 * HOUR, lastTokens: 0 },
  ];

  const model = buildDashboard(
    NOW,
    config,
    snapshot({
      machines: known,
      groups: [group("Work", 1, "#ff00aa"), group("Personal", 2)],
      events: [
        { machineId: "mac", groupId: "Personal", tokens: 300, ts: NOW.getTime() - 0.5 * HOUR },
        { machineId: "win-1", groupId: "Work", tokens: 100, ts: NOW.getTime() - 5 * HOUR },
      ],
    }),
  );

  it("lists reporting machines first, then silent ones with zero usage", () => {
    expect(model.machines.map((m) => [m.machineId, m.tokens])).toEqual([
      ["mac", 300],
      ["win-1", 100],
      ["win-2", 0],
    ]);
  });

  it("drops machines that have been silent for longer than `inactiveMachineDays`", () => {
    expect(model.machines.some((m) => m.machineId === "retired")).toBe(false);
  });

  it("grades freshness from the report interval", () => {
    expect(model.machines.map((m) => m.health)).toEqual(["active", "late", "inactive"]);
  });

  it("colours a machine like its group", () => {
    expect(model.machines.map((m) => m.color)).toEqual([PRESET_COLORS[0], "#ff00aa", "#ff00aa"]);
  });

  it("states every machine's share of the usage and of the limit", () => {
    expect(model.machines.map((m) => [m.share, m.limitShare])).toEqual([
      [0.75, 300 / 500_000],
      [0.25, 100 / 500_000],
      [0, 0],
    ]);
  });
});

describe("buildDashboard — manual machine health", () => {
  it("shows a manual machine as 'manual' rather than 'late', no matter how long since it last reported", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({
        // 5 h since the last report: an auto machine on the default interval would be "late" here.
        machines: [
          {
            machineId: "laptop",
            groupId: "Personal",
            lastSeenAt: NOW.getTime() - 5 * HOUR,
            lastTokens: 0,
            mode: "manual",
          },
        ],
        groups: [group("Personal", 1)],
      }),
    );
    expect(model.machines.find((m) => m.machineId === "laptop")?.health).toBe("manual");
  });

  it("still shows a manual machine as 'inactive' once it passes inactiveMachineDays, then drops it", () => {
    const shortWindow = { ...config, inactiveMachineDays: 2 };
    const withinWindow = buildDashboard(
      NOW,
      shortWindow,
      snapshot({
        machines: [
          {
            machineId: "laptop",
            groupId: "Personal",
            lastSeenAt: NOW.getTime() - 1.5 * 24 * HOUR,
            lastTokens: 0,
            mode: "manual",
          },
        ],
        groups: [group("Personal", 1)],
      }),
    );
    expect(withinWindow.machines.find((m) => m.machineId === "laptop")?.health).toBe("manual");

    // Past the window, a manual machine (like any other) is dropped from the list entirely.
    const pastWindow = buildDashboard(
      NOW,
      shortWindow,
      snapshot({
        machines: [
          {
            machineId: "laptop",
            groupId: "Personal",
            lastSeenAt: NOW.getTime() - 3 * 24 * HOUR,
            lastTokens: 0,
            mode: "manual",
          },
        ],
        groups: [group("Personal", 1)],
      }),
    );
    expect(pastWindow.machines.some((m) => m.machineId === "laptop")).toBe(false);
  });

  it("grades an auto machine against its own interval when the report carried one", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({
        machines: [
          // 25 min old: "active" on the server's default 60 min interval, but "late" on this
          // machine's own faster 5 min one ((2*5+10) = 20 min).
          {
            machineId: "fast",
            groupId: "Personal",
            lastSeenAt: NOW.getTime() - 25 * 60_000,
            lastTokens: 0,
            mode: "auto",
            intervalMinutes: 5,
          },
        ],
        groups: [group("Personal", 1)],
      }),
    );
    expect(model.machines.find((m) => m.machineId === "fast")?.health).toBe("late");
  });
});

describe("buildDashboard — timeline", () => {
  it("charts the groups in the table's order and ends on their totals", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({
        events: [
          report("mac", "Personal", 100_000, 20),
          { ...report("win-1", "Work", 150_000, 10), models: { "claude-opus-4-5": 150_000 } },
        ],
      }),
    );
    expect(model.timeline.times[0]).toBe(CYCLE_START);
    expect(model.timeline.times[model.timeline.times.length - 1]).toBe(NOW.getTime());
    expect(model.timeline.groups.map((g) => [g.groupId, g.values[g.values.length - 1]])).toEqual(
      model.groups.map((g) => [g.groupId, g.tokens]),
    );
    expect(model.timeline.models.map((m) => [m.modelId, m.tokens])).toEqual([["claude-opus-4-5", 150_000]]);
  });
});

describe("buildDashboard — cost", () => {
  it("has no cost field at all when nothing in the window carries one", () => {
    const model = buildDashboard(NOW, config, snapshot({ events: [report("win-1", "Work", 150_000, 10)] }));
    expect(model.cost).toBeUndefined();
  });

  it("gains an optional cost field, by group, machine and model, once at least one event carries one", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({
        events: [
          {
            ...report("win-1", "Work", 150_000, 10),
            costUsd: 4.5,
            modelCosts: { "claude-opus-4-5": 4.5 },
            models: { "claude-opus-4-5": 150_000 },
          },
          { ...report("mac", "Personal", 100_000, 20), costUsd: 1.2 },
        ],
      }),
    );
    expect(model.cost).toEqual({
      total: 5.7,
      byGroup: { Work: 4.5, Personal: 1.2 },
      byMachine: { "win-1": 4.5, mac: 1.2 },
      byModel: { "claude-opus-4-5": 4.5 },
    });
  });

  it("leaves a machine that never sent a cost figure out of byMachine/byGroup", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({
        events: [
          { ...report("win-1", "Work", 150_000, 10), costUsd: 4.5 },
          report("mac", "Personal", 100_000, 20), // no cost: this client never opted in
        ],
      }),
    );
    expect(model.cost?.byMachine).toEqual({ "win-1": 4.5 });
    expect(model.cost?.byGroup).toEqual({ Work: 4.5 });
  });
});

describe("buildProviderDashboards — which provider counts where", () => {
  const seen = NOW.getTime() - 0.5 * HOUR;
  const store = {
    eventsByProvider: {
      claude: [report("mac", "Home", 300, 50), report("work-pc", "Work", 700, 50)],
      openai: [report("mac", "Home", 100, 50), report("work-pc", "Work", 400, 50)],
      deepseek: [report("mac", "Home", 50, 50)],
    },
    groups: [group("Home", 1, "#3987e5"), group("Work", 2, "#d95926")],
    machines: [
      { providerId: "claude", machineId: "mac", groupId: "Home", lastSeenAt: seen, lastTokens: 300 },
      { providerId: "claude", machineId: "work-pc", groupId: "Work", lastSeenAt: seen, lastTokens: 700 },
      { providerId: "openai", machineId: "mac", groupId: "Home", lastSeenAt: seen, lastTokens: 100 },
      { providerId: "openai", machineId: "work-pc", groupId: "Work", lastSeenAt: seen, lastTokens: 400 },
      { providerId: "deepseek", machineId: "mac", groupId: "Home", lastSeenAt: seen, lastTokens: 50 },
    ],
  };
  const providerIds = ["claude", "openai", "deepseek"];

  it("shows every provider, with every group, while nothing is switched off", () => {
    const dashboards = buildProviderDashboards(NOW, config, providerIds, store);
    expect(dashboards.map((d) => [d.id, d.label, d.dashboard.total])).toEqual([
      ["claude", "Claude", 1000],
      ["openai", "OpenAI", 500],
      ["deepseek", "DeepSeek", 50],
    ]);
  });

  it("leaves a hidden provider out altogether", () => {
    const dashboards = buildProviderDashboards(NOW, { ...config, hiddenProviders: ["openai"] }, providerIds, store);
    expect(dashboards.map((d) => d.id)).toEqual(["claude", "deepseek"]);
  });

  it("leaves a group's reports of a provider it does not count for out of that provider only", () => {
    // The work machines only count for OpenAI.
    const scoped = { ...config, excludedProviders: { Work: ["claude", "deepseek"] } };
    const [claude, openai] = buildProviderDashboards(NOW, scoped, providerIds, store);

    expect(claude!.dashboard.total).toBe(300);
    expect(claude!.dashboard.groups.map((g) => [g.groupId, g.share])).toEqual([["Home", 1]]);
    expect(claude!.dashboard.machines.map((m) => m.machineId)).toEqual(["mac"]);
    expect(claude!.dashboard.timeline.groups.map((g) => g.groupId)).toEqual(["Home"]);

    expect(openai!.dashboard.total).toBe(500);
    expect(openai!.dashboard.groups.map((g) => g.groupId)).toEqual(["Work", "Home"]);
    expect(openai!.dashboard.machines.map((m) => m.machineId)).toEqual(["work-pc", "mac"]);
  });

  it("keeps a silent machine of an excluded group off the list too", () => {
    const quiet = { ...store, eventsByProvider: {} };
    const scoped = { ...config, excludedProviders: { Work: ["claude"] } };
    const [claude] = buildProviderDashboards(NOW, scoped, providerIds, quiet);
    expect(claude!.dashboard.machines.map((m) => [m.machineId, m.tokens])).toEqual([["mac", 0]]);
  });

  it("keeps each group's colour whichever provider is selected", () => {
    const scoped = { ...config, excludedProviders: { Home: ["openai"] } };
    const [, openai] = buildProviderDashboards(NOW, scoped, providerIds, store);
    expect(openai!.dashboard.groups.map((g) => [g.groupId, g.color])).toEqual([["Work", "#d95926"]]);
  });

  it("carries each provider's own ground-truth figure, and its sub-limits', by field", () => {
    const withSubLimit = {
      ...config,
      subLimits: {
        claude: [
          { id: "fable", name: "Fable", models: ["fable"], mode: "share" as const, sharePercent: 20, limit: 100_000 },
        ],
      },
    };
    const officialUsage = new Map([
      ["claude", { raw: "80", enteredAt: 1 }],
      ["claude:fable", { raw: "20", enteredAt: 2 }],
      ["openai", { raw: "50", enteredAt: 3 }],
    ]);
    const [claude, openai, deepseek] = buildProviderDashboards(NOW, withSubLimit, providerIds, store, officialUsage);

    expect(claude!.officialEntry).toEqual({ raw: "80", enteredAt: 1 });
    expect(claude!.subLimitEntries).toEqual({ fable: { raw: "20", enteredAt: 2 } });
    expect(openai!.officialEntry).toEqual({ raw: "50", enteredAt: 3 });
    expect(openai!.subLimitEntries).toEqual({});
    expect(deepseek!.officialEntry).toBeNull();
  });

  it("returns an empty list rather than throwing when no provider is known yet", () => {
    expect(buildProviderDashboards(NOW, config, [], store)).toEqual([]);
    // Also with a store that has nothing at all: a fresh install with only heartbeats so far.
    expect(buildProviderDashboards(NOW, config, [], { eventsByProvider: {}, groups: [], machines: [] })).toEqual([]);
  });
});
