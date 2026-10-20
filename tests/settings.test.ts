import { describe, expect, it } from "vitest";
import { getConfig, isValidTimeZone } from "@/lib/config";
import { getCycle } from "@/lib/cycle";
import { MAX_PROVIDERS } from "@/lib/providers";
import {
  applySettings,
  buildSettingsView,
  configForProvider,
  countsForProvider,
  MAX_ALERT_THRESHOLDS,
  MAX_GROUPS,
  NEUTRAL_COLOR,
  normalizeHexColor,
  PRESET_COLORS,
  parseGroupEntry,
  parseSettingsUpdate,
  parseStoredSettings,
  randomGroupColor,
  resetFor,
  resolveConfig,
  resolveGroupColors,
  serializeGroupEntry,
  serializeSettings,
  settingsFromConfig,
  suggestGroupColor,
  type UsageSettings,
  visibleProviderIds,
} from "@/lib/settings";

const config = getConfig({});
const DEFAULTS = settingsFromConfig(config);

// Every field differs from its default, so a round trip proves each one is carried.
const MONTHLY: UsageSettings = {
  period: "monthly",
  useTokenLimits: true,
  limits: { claude: 2_000_000, deepseek: 1_250_000 },
  reset: { weekday: 4, monthDay: 15, hour: 9, minute: 30, timeZone: "America/New_York" },
  resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } },
  showRemaining: false,
  costEstimate: true,
  hiddenProviders: ["openai"],
  excludedProviders: { Work: ["claude", "deepseek"] },
  subLimits: {
    claude: [
      { id: "fable", name: "Fable", models: ["fable"], mode: "separate", sharePercent: 50, limit: 400_000 },
      { id: "opus", name: "Opus", models: ["opus-5", "opus-4"], mode: "share", sharePercent: 30, limit: 2_000_000 },
    ],
  },
  alerts: {
    webhookUrl: "https://hooks.example.com/alerts",
    thresholds: [25, 50, 90],
    perProvider: false,
    format: "slack",
    locale: "hu",
  },
};

describe("isValidTimeZone", () => {
  it("accepts IANA names and rejects everything else", () => {
    for (const zone of ["UTC", "Europe/Budapest", "America/New_York", "Asia/Tokyo"]) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
    for (const zone of ["", "Not/AZone", "GMT+2", "budapest"]) {
      expect(isValidTimeZone(zone)).toBe(false);
    }
  });
});

describe("stored settings", () => {
  it("fall back to the configured defaults while nothing is saved", () => {
    expect(DEFAULTS).toEqual({
      period: "weekly",
      useTokenLimits: false,
      limits: {},
      reset: { weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "UTC" },
      resetOverrides: {},
      showRemaining: true,
      costEstimate: false,
      hiddenProviders: [],
      excludedProviders: {},
      subLimits: {},
      alerts: { webhookUrl: null, thresholds: [50, 80, 100], perProvider: true, format: "generic", locale: "en" },
    });
    expect(parseStoredSettings(null, DEFAULTS)).toEqual(DEFAULTS);
    expect(resolveConfig(config, null)).toEqual({
      ...config,
      providerLimits: {},
    });
  });

  it("seed the defaults from the env vars, the time zone included", () => {
    const seeded = settingsFromConfig(
      getConfig({ WEEKLY_LIMIT: "750_000", RESET_WEEKDAY: "3", RESET_TIME: "06:15", RESET_TIMEZONE: "Asia/Tokyo" }),
    );
    expect(seeded).toEqual({
      period: "weekly",
      useTokenLimits: false,
      // No provider is known yet: the seed limit has nowhere to apply until one reports.
      limits: {},
      reset: { weekday: 3, monthDay: 1, hour: 6, minute: 15, timeZone: "Asia/Tokyo" },
      resetOverrides: {},
      showRemaining: true,
      costEstimate: false,
      hiddenProviders: [],
      excludedProviders: {},
      subLimits: {},
      alerts: DEFAULTS.alerts,
    });
  });

  it("survive a round trip through Redis, tagged as v3", () => {
    const raw = serializeSettings(MONTHLY, new Date("2026-09-21T10:00:00Z"));
    expect(JSON.parse(raw)).toMatchObject({ v: 3, period: "monthly", updatedAt: 1789984800000 });
    expect(parseStoredSettings(raw, DEFAULTS)).toEqual(MONTHLY);
  });

  it("override the defaults, the time zone included, but not the other configuration", () => {
    const effective = resolveConfig(config, serializeSettings(MONTHLY, new Date()), ["claude", "deepseek"]);
    expect(configForProvider(effective, "claude").limit).toBe(2_000_000);
    expect(configForProvider(effective, "deepseek").limit).toBe(1_250_000);
    expect(effective.reset).toEqual({
      period: "monthly",
      weekday: 4,
      monthDay: 15,
      hour: 9,
      minute: 30,
      timeZone: "America/New_York",
    });
    expect(effective.useTokenLimits).toBe(true);
    expect(effective.showRemaining).toBe(false);
    expect(effective.tokenMode).toBe(config.tokenMode);
    expect(effective.retentionDays).toBe(config.retentionDays);

    // Monthly reset on the 15th at 09:30 America/New_York (EDT, UTC-4 in September) = 13:30 UTC.
    const cycle = getCycle(new Date("2026-09-23T10:00:00Z"), effective.reset);
    expect(cycle.start.toISOString()).toBe("2026-09-15T13:30:00.000Z");
  });

  it("falls back to the deploy-time zone when the stored one is missing or invalid", () => {
    for (const badReset of [
      { weekday: 9, monthDay: 31, hour: "7", minute: 45 },
      { weekday: 9, monthDay: 31, hour: "7", minute: 45, timeZone: "Mars/Colony" },
      { weekday: 9, monthDay: 31, hour: "7", minute: 45, timeZone: 7 },
    ]) {
      const raw = JSON.stringify({ period: "yearly", limit: 1_234_567, reset: badReset });
      expect(parseStoredSettings(raw, DEFAULTS).reset.timeZone).toBe(DEFAULTS.reset.timeZone);
    }
  });

  it("are read field by field: what does not hold up falls back to its default", () => {
    const raw = JSON.stringify({
      period: "yearly",
      limit: 1_234_567,
      reset: { weekday: 9, monthDay: 31, hour: "7", minute: 45 },
    });
    expect(parseStoredSettings(raw, DEFAULTS)).toEqual({
      period: "weekly",
      useTokenLimits: false,
      // v1's global `limit` would apply to every already-known provider; none is known here.
      limits: {},
      reset: { weekday: 1, monthDay: 31, hour: 0, minute: 45, timeZone: "UTC" },
      resetOverrides: {},
      showRemaining: true,
      costEstimate: false,
      hiddenProviders: [],
      excludedProviders: {},
      subLimits: {},
      alerts: DEFAULTS.alerts,
    });
  });

  it("read a document saved before the remaining-tokens switch existed: it stays on", () => {
    // Exactly what the first deployed version of the panel wrote: no `showRemaining` at all.
    const raw =
      '{"v":1,"period":"monthly","limit":2000000,"reset":{"weekday":4,"monthDay":15,"hour":9,"minute":30},"updatedAt":1789997466594}';
    expect(parseStoredSettings(raw, DEFAULTS)).toEqual({
      ...MONTHLY,
      useTokenLimits: false,
      // No provider is known on `DEFAULTS`, so v1's global limit has nothing to apply to.
      limits: {},
      // The document has no `reset.timeZone` (it predates the field): the default zone wins.
      reset: { ...MONTHLY.reset, timeZone: DEFAULTS.reset.timeZone },
      resetOverrides: {},
      showRemaining: true,
      costEstimate: false,
      hiddenProviders: [],
      excludedProviders: {},
      subLimits: {},
      // No `alerts` in the document either (it predates the field): it parses to off.
      alerts: DEFAULTS.alerts,
    });
    expect(resolveConfig(config, raw).showRemaining).toBe(true);
  });

  it("read a document saved before the token-limit switch existed: the limits go off, but are kept", () => {
    // What the panel wrote until then: per-provider limits and the remaining-tokens switch, no `useTokenLimits`.
    const raw =
      '{"v":2,"period":"weekly","limits":{"claude":2000000,"deepseek":750000},"reset":{"weekday":1,"monthDay":1,"hour":0,"minute":0},"showRemaining":false,"updatedAt":1790000000000}';
    const stored = parseStoredSettings(raw, DEFAULTS);
    expect(stored.useTokenLimits).toBe(false);
    expect(stored.limits).toEqual({ claude: 2_000_000, deepseek: 750_000 });
    expect(stored.showRemaining).toBe(false);
    // Nor did the provider switches exist: every provider shows, and every group counts for it.
    expect(stored.hiddenProviders).toEqual([]);
    expect(stored.excludedProviders).toEqual({});
    expect(stored.subLimits).toEqual({});
    const effective = resolveConfig(config, raw, ["claude", "deepseek"]);
    expect(effective.useTokenLimits).toBe(false);
    // Switching the limits back on finds them as they were.
    expect(configForProvider(effective, "claude").limit).toBe(2_000_000);
  });

  it("take only a real boolean for the switches", () => {
    for (const value of ["false", 0, null, "no", []]) {
      const raw = JSON.stringify({ ...MONTHLY, showRemaining: value });
      expect(parseStoredSettings(raw, DEFAULTS).showRemaining).toBe(true);
    }
    expect(parseStoredSettings(JSON.stringify(MONTHLY), DEFAULTS).showRemaining).toBe(false);
    for (const value of ["true", 1, null, "yes", {}]) {
      const raw = JSON.stringify({ ...MONTHLY, useTokenLimits: value });
      expect(parseStoredSettings(raw, DEFAULTS).useTokenLimits).toBe(false);
    }
    expect(parseStoredSettings(JSON.stringify(MONTHLY), DEFAULTS).useTokenLimits).toBe(true);
  });

  it("keep the valid parts of the provider switches, and nothing else", () => {
    const raw = JSON.stringify({
      ...MONTHLY,
      hiddenProviders: [" OpenAI ", "openai", "bad/id", 42, "gemini"],
      excludedProviders: {
        " Work ": ["claude", "Claude", "no such/provider"],
        "a/b": ["claude"],
        Home: [],
        Lab: "claude",
        constructor: ["deepseek"],
      },
    });
    const stored = parseStoredSettings(raw, DEFAULTS);
    expect(stored.hiddenProviders).toEqual(["openai", "gemini"]);
    expect(stored.excludedProviders).toEqual({ Work: ["claude"], constructor: ["deepseek"] });
    for (const value of [null, "openai", { openai: true }]) {
      expect(
        parseStoredSettings(JSON.stringify({ ...MONTHLY, hiddenProviders: value }), DEFAULTS).hiddenProviders,
      ).toEqual([]);
    }
    expect(
      parseStoredSettings(JSON.stringify({ ...MONTHLY, excludedProviders: ["Work"] }), DEFAULTS).excludedProviders,
    ).toEqual({});
  });

  it("keep the valid sub-limits, each id once, and drop the rest", () => {
    const fable = MONTHLY.subLimits.claude![0]!;
    const raw = JSON.stringify({
      ...MONTHLY,
      subLimits: {
        Claude: [
          { ...fable, name: "  Fable   5 " },
          { ...fable, name: "Twice" },
          { ...fable, id: "Bad Id" },
          { ...fable, id: "no-models", models: [] },
          { ...fable, id: "bad-mode", mode: "both" },
          { ...fable, id: "bad-share", sharePercent: 0 },
          { ...fable, id: "bad-limit", limit: 1.5 },
          { ...fable, id: "upper", models: [" Opus-5 ", "opus-5", "bad/part"] },
        ],
        "bad/provider": [fable],
        deepseek: "fable",
        openai: [],
      },
    });
    expect(parseStoredSettings(raw, DEFAULTS).subLimits).toEqual({
      claude: [{ ...fable, name: "Fable 5" }],
    });
  });

  it("round-trips alerts, and a document without one parses to off", () => {
    expect(parseStoredSettings(JSON.stringify(MONTHLY), DEFAULTS).alerts).toEqual(MONTHLY.alerts);
    const { alerts: _alerts, ...withoutAlerts } = MONTHLY;
    expect(parseStoredSettings(JSON.stringify(withoutAlerts), DEFAULTS).alerts).toEqual(DEFAULTS.alerts);
    expect(DEFAULTS.alerts.webhookUrl).toBeNull();
  });

  it("reads alerts field by field: what does not hold up keeps its default", () => {
    const raw = JSON.stringify({
      ...MONTHLY,
      alerts: {
        webhookUrl: "http://not-https.example.com",
        thresholds: [200, -1, "x"],
        perProvider: "yes",
        format: "teams",
        locale: "xx",
      },
    });
    expect(parseStoredSettings(raw, DEFAULTS).alerts).toEqual(DEFAULTS.alerts);
  });

  it("keeps an allowed webhook URL and rejects a disallowed one", () => {
    const allowed = JSON.stringify({ ...MONTHLY, alerts: { ...MONTHLY.alerts, webhookUrl: "https://example.com/x" } });
    expect(parseStoredSettings(allowed, DEFAULTS).alerts.webhookUrl).toBe("https://example.com/x");
    const blocked = JSON.stringify({ ...MONTHLY, alerts: { ...MONTHLY.alerts, webhookUrl: "https://localhost/x" } });
    expect(parseStoredSettings(blocked, DEFAULTS).alerts.webhookUrl).toBeNull();
  });

  it("dedupes and sorts stored thresholds", () => {
    const raw = JSON.stringify({ ...MONTHLY, alerts: { ...MONTHLY.alerts, thresholds: [90, 50, 90, 25] } });
    expect(parseStoredSettings(raw, DEFAULTS).alerts.thresholds).toEqual([25, 50, 90]);
  });

  it("never fail on a corrupt document", () => {
    for (const raw of ["", "not json", "null", "42", '"weekly"', "[]", '{"limit":0}', '{"limit":1.5}', '{"reset":7}']) {
      expect(parseStoredSettings(raw, DEFAULTS)).toEqual(DEFAULTS);
    }
  });
});

describe("parseSettingsUpdate", () => {
  const valid = {
    period: "monthly",
    useTokenLimits: true,
    limits: { claude: 2_000_000, deepseek: 1_250_000 },
    reset: { weekday: 4, monthDay: 15, hour: 9, minute: 30, timeZone: "America/New_York" },
    resetOverrides: { Claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } },
    showRemaining: false,
    costEstimate: true,
    hiddenProviders: ["OpenAI", "openai"],
    excludedProviders: { " Work ": ["claude", "deepseek"], Home: [] },
    subLimits: {
      Claude: [
        { id: "fable", name: " Fable ", models: ["Fable"], mode: "separate", sharePercent: 50, limit: 400_000 },
        {
          id: "opus",
          name: "Opus",
          models: ["opus-5", "OPUS-4", "opus-5"],
          mode: "share",
          sharePercent: 30,
          limit: 2_000_000,
        },
      ],
      deepseek: [],
    },
    alerts: {
      webhookUrl: "https://hooks.example.com/alerts",
      thresholds: [90, 25, 50, 25],
      perProvider: false,
      format: "slack",
      locale: "hu",
    },
    groups: [
      { id: " Work ", color: "#3987E5" },
      { id: "Személyes", color: "#abc" },
    ],
    removedGroups: ["Old", "Old"],
  };

  it("accepts a report's source marker on an override, and nothing else there", () => {
    const withSource = parseSettingsUpdate({
      ...valid,
      resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0, source: "report" } },
    });
    if (!withSource.ok) throw new Error(withSource.errors.join("; "));
    expect(withSource.update.settings.resetOverrides.claude).toEqual({
      weekday: 4,
      monthDay: 1,
      hour: 9,
      minute: 0,
      source: "report",
    });
    const bad = parseSettingsUpdate({
      ...valid,
      resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0, source: "panel" } },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toContain('resetOverrides.claude.source must be "report", or absent');
  });

  it("accepts a complete update and normalizes ids and colours", () => {
    expect(parseSettingsUpdate(valid)).toEqual({
      ok: true,
      update: {
        settings: MONTHLY,
        groups: [
          { id: "Work", color: "#3987e5" },
          { id: "Személyes", color: "#aabbcc" },
        ],
        removedGroups: ["Old"],
      },
    });
  });

  it("normalizes the reset overrides' provider ids", () => {
    const result = parseSettingsUpdate(valid);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.update.settings.resetOverrides).toEqual({ claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } });
  });

  it("requires resetOverrides, and checks every field of every entry", () => {
    const { resetOverrides: _, ...missing } = valid;
    expect(parseSettingsUpdate(missing)).toMatchObject({ ok: false });
    const bad = parseSettingsUpdate({
      ...valid,
      resetOverrides: { claude: { weekday: 7, monthDay: 0, hour: 24, minute: 60 } },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toEqual(
        expect.arrayContaining([
          "resetOverrides.claude.weekday must be 0 (Sunday) to 6 (Saturday)",
          "resetOverrides.claude.monthDay must be 1 to 31",
          "resetOverrides.claude.hour must be 0 to 23",
          "resetOverrides.claude.minute must be 0 to 59",
        ]),
      );
    }
    expect(
      parseSettingsUpdate({ ...valid, resetOverrides: { "!!": { weekday: 1, monthDay: 1, hour: 0, minute: 0 } } }).ok,
    ).toBe(false);
  });

  it("accepts up to 20 alert thresholds, sorted", () => {
    expect(MAX_ALERT_THRESHOLDS).toBe(20);
    const thresholds = Array.from({ length: 20 }, (_, i) => 100 - i * 5);
    const result = parseSettingsUpdate({ ...valid, alerts: { ...valid.alerts, thresholds } });
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.update.settings.alerts.thresholds).toEqual([...thresholds].sort((a, b) => a - b));
  });

  it("treats the group lists as optional", () => {
    const { groups: _groups, removedGroups: _removed, ...budgetOnly } = valid;
    const result = parseSettingsUpdate(budgetOnly);
    expect(result.ok && result.update.groups).toEqual([]);
    expect(result.ok && result.update.removedGroups).toEqual([]);
  });

  it("defaults nothing: every budget field is required", () => {
    const result = parseSettingsUpdate({});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toHaveLength(15);
    expect(!result.ok && result.errors).toContain(
      `hiddenProviders must be an array of at most ${MAX_PROVIDERS} provider ids`,
    );
    expect(!result.ok && result.errors).toContain("useTokenLimits must be true or false");
    expect(!result.ok && result.errors).toContain("showRemaining must be true or false");
    expect(!result.ok && result.errors).toContain("reset.timeZone must be a valid IANA time zone name");
  });

  it.each([
    ["a non-object body", [valid]],
    ["an unknown period", { ...valid, period: "daily" }],
    ["a missing token-limit switch", { ...valid, useTokenLimits: undefined }],
    ["the token-limit switch given as text", { ...valid, useTokenLimits: "true" }],
    ["the token-limit switch given as a number", { ...valid, useTokenLimits: 1 }],
    ["an empty limits map", { ...valid, limits: {} }],
    ["a zero limit", { ...valid, limits: { claude: 0 } }],
    ["a fractional limit", { ...valid, limits: { claude: 1000.5 } }],
    ["a limit given as text", { ...valid, limits: { claude: "500000" } }],
    ["an absurd limit", { ...valid, limits: { claude: 1e15 } }],
    ["an invalid provider", { ...valid, limits: { "bad/provider": 10 } }],
    ["weekday 7", { ...valid, reset: { ...valid.reset, weekday: 7 } }],
    ["month day 0", { ...valid, reset: { ...valid.reset, monthDay: 0 } }],
    ["month day 32", { ...valid, reset: { ...valid.reset, monthDay: 32 } }],
    ["hour 24", { ...valid, reset: { ...valid.reset, hour: 24 } }],
    ["minute 60", { ...valid, reset: { ...valid.reset, minute: 60 } }],
    ["a missing time zone", { ...valid, reset: { ...valid.reset, timeZone: undefined } }],
    ["a time zone given as a number", { ...valid, reset: { ...valid.reset, timeZone: 7 } }],
    ["an unknown time zone", { ...valid, reset: { ...valid.reset, timeZone: "Mars/Colony" } }],
    ["a missing remaining-tokens switch", { ...valid, showRemaining: undefined }],
    ["the switch given as text", { ...valid, showRemaining: "false" }],
    ["the switch given as a number", { ...valid, showRemaining: 0 }],
    ["a missing cost estimate switch", { ...valid, costEstimate: undefined }],
    ["the cost estimate switch given as text", { ...valid, costEstimate: "true" }],
    ["hidden providers that are not a list", { ...valid, hiddenProviders: "openai" }],
    ["a hidden provider that is no id", { ...valid, hiddenProviders: ["bad/provider"] }],
    [
      "too many hidden providers",
      { ...valid, hiddenProviders: Array.from({ length: MAX_PROVIDERS + 1 }, (_, i) => `p${i}`) },
    ],
    ["exclusions that are a list", { ...valid, excludedProviders: [["Work", "claude"]] }],
    ["exclusions of a group that is no id", { ...valid, excludedProviders: { "a/b": ["claude"] } }],
    ["exclusions that are not a list", { ...valid, excludedProviders: { Work: "claude" } }],
    ["an excluded provider that is no id", { ...valid, excludedProviders: { Work: ["bad/provider"] } }],
    [
      "a group excluded twice after trimming",
      { ...valid, excludedProviders: { Work: ["claude"], " Work": ["deepseek"] } },
    ],
    ["sub-limits that are a list", { ...valid, subLimits: [] }],
    ["sub-limits of an invalid provider", { ...valid, subLimits: { "bad/provider": [] } }],
    ["a provider's sub-limits that are no list", { ...valid, subLimits: { claude: {} } }],
    [
      "too many sub-limits",
      {
        ...valid,
        subLimits: { claude: Array.from({ length: 6 }, (_, i) => ({ ...valid.subLimits.Claude[0], id: `s${i}` })) },
      },
    ],
    [
      "a sub-limit id with capitals",
      { ...valid, subLimits: { claude: [{ ...valid.subLimits.Claude[0], id: "Fable" }] } },
    ],
    [
      "the same sub-limit id twice",
      { ...valid, subLimits: { claude: [valid.subLimits.Claude[0], valid.subLimits.Claude[0]] } },
    ],
    ["an empty sub-limit name", { ...valid, subLimits: { claude: [{ ...valid.subLimits.Claude[0], name: "  " }] } }],
    [
      "a sub-limit name that is too long",
      { ...valid, subLimits: { claude: [{ ...valid.subLimits.Claude[0], name: "x".repeat(41) }] } },
    ],
    ["a sub-limit without models", { ...valid, subLimits: { claude: [{ ...valid.subLimits.Claude[0], models: [] }] } }],
    [
      "a model part with a slash",
      { ...valid, subLimits: { claude: [{ ...valid.subLimits.Claude[0], models: ["a/b"] }] } },
    ],
    ["an unknown sub-limit mode", { ...valid, subLimits: { claude: [{ ...valid.subLimits.Claude[0], mode: "own" }] } }],
    ["a share above 100%", { ...valid, subLimits: { claude: [{ ...valid.subLimits.Claude[0], sharePercent: 101 }] } }],
    ["a fractional share", { ...valid, subLimits: { claude: [{ ...valid.subLimits.Claude[0], sharePercent: 12.5 }] } }],
    [
      "a sub-limit without a token limit",
      { ...valid, subLimits: { claude: [{ ...valid.subLimits.Claude[0], limit: undefined }] } },
    ],
    ["alerts that are not an object", { ...valid, alerts: null }],
    ["a webhook URL that is not https", { ...valid, alerts: { ...valid.alerts, webhookUrl: "http://example.com" } }],
    ["a webhook URL pointed at localhost", { ...valid, alerts: { ...valid.alerts, webhookUrl: "https://localhost" } }],
    [
      "a webhook URL with credentials",
      { ...valid, alerts: { ...valid.alerts, webhookUrl: "https://user:pass@example.com" } },
    ],
    ["an empty thresholds list", { ...valid, alerts: { ...valid.alerts, thresholds: [] } }],
    [
      "more than MAX_ALERT_THRESHOLDS thresholds",
      {
        ...valid,
        alerts: { ...valid.alerts, thresholds: Array.from({ length: MAX_ALERT_THRESHOLDS + 1 }, (_, i) => i + 1) },
      },
    ],
    ["a threshold of 0", { ...valid, alerts: { ...valid.alerts, thresholds: [0] } }],
    ["a threshold above 100", { ...valid, alerts: { ...valid.alerts, thresholds: [101] } }],
    ["a non-boolean perProvider", { ...valid, alerts: { ...valid.alerts, perProvider: "true" } }],
    ["an unknown alert format", { ...valid, alerts: { ...valid.alerts, format: "teams" } }],
    ["an unsupported alert locale", { ...valid, alerts: { ...valid.alerts, locale: "xx" } }],
    ["groups that are not a list", { ...valid, groups: { Work: "#3987e5" } }],
    ["a group id with a slash", { ...valid, groups: [{ id: "a/b", color: "#3987e5" }] }],
    ["an empty group id", { ...valid, groups: [{ id: "  ", color: "#3987e5" }] }],
    ["a colour name", { ...valid, groups: [{ id: "Work", color: "red" }] }],
    ["a Tailwind class as the colour", { ...valid, groups: [{ id: "Work", color: "bg-blue-500" }] }],
    ["the same group twice", { ...valid, groups: [valid.groups[0], valid.groups[0]] }],
    ["a group both kept and removed", { ...valid, removedGroups: ["Work"] }],
    ["a removed id that is no id", { ...valid, removedGroups: [42] }],
    [
      "too many groups",
      { ...valid, groups: Array.from({ length: MAX_GROUPS + 1 }, (_, i) => ({ id: `g${i}`, color: "#3987e5" })) },
    ],
  ])("rejects %s", (_name, body) => {
    const result = parseSettingsUpdate(body);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.length).toBeGreaterThan(0);
  });
});

describe("group colours", () => {
  it("normalizes hex colours and rejects everything else", () => {
    expect(normalizeHexColor("#3987E5")).toBe("#3987e5");
    expect(normalizeHexColor(" #FfF ")).toBe("#ffffff");
    for (const bad of ["3987e5", "#3987e", "#3987e5ff", "#ggg", "rgb(0,0,0)", "", null, 0x3987e5]) {
      expect(normalizeHexColor(bad)).toBeNull();
    }
  });

  // WCAG relative luminance, for checking the random colours against the page background.
  function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((at) => {
      const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  it("draws random colours that stay legible on the dark page, whatever the hue", () => {
    const page = luminance("#1a1a19");
    for (let hue = 0; hue < 360; hue += 5) {
      for (const extreme of [0, 0.999]) {
        const rolls = [hue / 360, extreme, extreme];
        const color = randomGroupColor(() => rolls.shift() ?? 0);
        expect(color).toMatch(/^#[0-9a-f]{6}$/);
        // 3:1 is the WCAG minimum for graphical marks.
        expect((luminance(color) + 0.05) / (page + 0.05)).toBeGreaterThan(3);
      }
    }
  });

  it("draws different colours from different rolls", () => {
    expect(randomGroupColor(() => 0)).toBe("#d16161");
    expect(randomGroupColor(() => 0.5)).not.toBe(randomGroupColor(() => 0));
  });

  it("suggests the first free preset for a new group, then random colours", () => {
    expect(suggestGroupColor([])).toBe(PRESET_COLORS[0]);
    expect(suggestGroupColor([PRESET_COLORS[0], PRESET_COLORS[1], "#123456"])).toBe(PRESET_COLORS[2]);
    expect(suggestGroupColor([...PRESET_COLORS], () => 0)).toBe(randomGroupColor(() => 0));
  });

  it("keeps stored colours and hands the free presets to the rest by first appearance", () => {
    const colors = resolveGroupColors([
      { groupId: "late", color: null, firstSeenAt: 300 },
      { groupId: "stored", color: PRESET_COLORS[0], firstSeenAt: 200 },
      { groupId: "early", color: null, firstSeenAt: 100 },
    ]);
    expect([...colors]).toEqual([
      ["stored", PRESET_COLORS[0]],
      ["early", PRESET_COLORS[1]],
      ["late", PRESET_COLORS[2]],
    ]);
  });

  it("lets two groups share a colour when that was saved", () => {
    const colors = resolveGroupColors([
      { groupId: "a", color: "#123456", firstSeenAt: 1 },
      { groupId: "b", color: "#123456", firstSeenAt: 2 },
    ]);
    expect(colors.get("a")).toBe("#123456");
    expect(colors.get("b")).toBe("#123456");
  });
});

describe("the usage:groups hash", () => {
  it("round-trips an entry", () => {
    expect(parseGroupEntry("Work", serializeGroupEntry("#3987e5", 1758459950820))).toEqual({
      groupId: "Work",
      color: "#3987e5",
      firstSeenAt: 1758459950820,
    });
  });

  it("reads entries written before groups had colours: a bare first-seen time", () => {
    expect(parseGroupEntry("Work", "1758459950820")).toEqual({
      groupId: "Work",
      color: null,
      firstSeenAt: 1758459950820,
    });
  });

  it("keeps a group whose entry is unreadable", () => {
    for (const raw of ["", "{", "null", '"x"', '{"color":"red","ts":"soon"}']) {
      expect(parseGroupEntry("Work", raw)).toEqual({ groupId: "Work", color: null, firstSeenAt: 0 });
    }
  });
});

describe("providers on the dashboard", () => {
  const effective = resolveConfig(config, serializeSettings(MONTHLY, new Date()), ["claude", "deepseek", "openai"]);

  it("leave the hidden ones out, in the given order", () => {
    expect(visibleProviderIds(effective, ["openai", "deepseek", "claude"])).toEqual(["deepseek", "claude"]);
  });

  it("show them all should every one be hidden", () => {
    expect(visibleProviderIds({ ...effective, hiddenProviders: ["claude", "openai"] }, ["claude", "openai"])).toEqual([
      "claude",
      "openai",
    ]);
  });

  it("count a group for every provider it does not exclude", () => {
    expect(countsForProvider(effective.excludedProviders, "Work", "claude")).toBe(false);
    expect(countsForProvider(effective.excludedProviders, "Work", "openai")).toBe(true);
    expect(countsForProvider(effective.excludedProviders, "Home", "claude")).toBe(true);
  });

  it("never mistake the object's own methods for a group", () => {
    for (const groupId of ["constructor", "toString", "hasOwnProperty"]) {
      expect(countsForProvider({}, groupId, "claude")).toBe(true);
    }
    expect(countsForProvider({ constructor: ["claude"] }, "constructor", "claude")).toBe(false);
  });
});

describe("buildSettingsView", () => {
  it("lists the groups in order of first appearance, each with a colour", () => {
    const view = buildSettingsView(
      resolveConfig(config, serializeSettings(MONTHLY, new Date()), ["claude", "deepseek"]),
      [
        { groupId: "Personal", color: null, firstSeenAt: 200, hasReports: true },
        { groupId: "Work", color: "#ff00aa", firstSeenAt: 100, hasReports: false },
      ],
      ["claude", "deepseek"],
      { claude: ["claude-fable-5-1"], openai: ["gpt-5"] },
    );
    expect(view).toEqual({
      settings: MONTHLY,
      timeZone: "America/New_York",
      providers: [
        { id: "claude", label: "Claude", models: ["claude-fable-5-1"] },
        { id: "deepseek", label: "DeepSeek", models: [] },
      ],
      groups: [
        { id: "Work", color: "#ff00aa", hasReports: false },
        { id: "Personal", color: PRESET_COLORS[0], hasReports: true },
      ],
    });
  });

  it("has a colour even for the ninth group without one", () => {
    const groups = Array.from({ length: 9 }, (_, i) => ({
      groupId: `g${i}`,
      color: null,
      firstSeenAt: i,
      hasReports: false,
    }));
    expect(buildSettingsView(config, groups).groups[8]?.color).toBe(NEUTRAL_COLOR);
  });

  it("stays renderable with no provider known yet: a fresh install with only heartbeats so far", () => {
    const view = buildSettingsView(config, [], []);
    expect(view.providers).toEqual([]);
    expect(view.settings.limits).toEqual({});
    expect(view.groups).toEqual([]);
    expect(view.timeZone).toBe(config.reset.timeZone);
  });
});

describe("per-provider reset", () => {
  const base = getConfig();

  it("keeps a report's source marker, and drops anything else in that field", () => {
    const defaults = settingsFromConfig(getConfig());
    const raw = JSON.stringify({
      ...defaults,
      resetOverrides: {
        claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0, source: "report" },
        openai: { weekday: 1, monthDay: 1, hour: 0, minute: 0, source: "someone" },
      },
    });
    expect(parseStoredSettings(raw, defaults).resetOverrides).toEqual({
      claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0, source: "report" },
      openai: { weekday: 1, monthDay: 1, hour: 0, minute: 0 },
    });
  });

  it("resetFor falls back to the shared reset without an override", () => {
    const config = { ...base, resetOverrides: {} };
    expect(resetFor(config, "claude")).toEqual(config.reset);
  });

  it("resetFor lays a provider's override over the shared period and time zone", () => {
    const config = {
      ...base,
      reset: { ...base.reset, period: "weekly" as const, timeZone: "Europe/Budapest" },
      resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 15 } },
    };
    expect(resetFor(config, "claude")).toEqual({
      period: "weekly",
      timeZone: "Europe/Budapest",
      weekday: 4,
      monthDay: 1,
      hour: 9,
      minute: 15,
    });
    expect(resetFor(config, "openai")).toEqual(config.reset);
  });

  it("configForProvider carries the provider's reset", () => {
    const config = { ...base, resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } } };
    expect(configForProvider(config, "claude").reset.weekday).toBe(4);
    expect(configForProvider(config, "openai").reset).toEqual(config.reset);
  });

  it("stored overrides round-trip, and bad entries are dropped one by one", () => {
    const defaults = settingsFromConfig(base);
    const raw = JSON.stringify({
      ...defaults,
      resetOverrides: {
        Claude: { weekday: 4, monthDay: 1, hour: 9, minute: 15 },
        openai: { weekday: 9, monthDay: 1, hour: 0, minute: 0 },
        "": { weekday: 1, monthDay: 1, hour: 0, minute: 0 },
      },
    });
    expect(parseStoredSettings(raw, defaults).resetOverrides).toEqual({
      claude: { weekday: 4, monthDay: 1, hour: 9, minute: 15 },
    });
  });

  it("a document without the field keeps no override", () => {
    const defaults = settingsFromConfig(base);
    const { resetOverrides: _, ...withoutField } = defaults;
    expect(parseStoredSettings(JSON.stringify(withoutField), defaults).resetOverrides).toEqual({});
  });

  it("applySettings and settingsFromConfig carry the overrides", () => {
    const settings = {
      ...settingsFromConfig(base),
      resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } },
    };
    const config = applySettings(base, settings);
    expect(config.resetOverrides).toEqual(settings.resetOverrides);
    expect(settingsFromConfig(config).resetOverrides).toEqual(settings.resetOverrides);
  });
});
