import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { getCycle } from "@/lib/cycle";
import {
  buildSettingsView,
  MAX_GROUPS,
  NEUTRAL_COLOR,
  normalizeHexColor,
  parseGroupEntry,
  parseSettingsUpdate,
  parseStoredSettings,
  PRESET_COLORS,
  randomGroupColor,
  resolveConfig,
  resolveGroupColors,
  serializeGroupEntry,
  serializeSettings,
  settingsFromConfig,
  suggestGroupColor,
  type UsageSettings,
} from "@/lib/settings";

const config = getConfig({});
const DEFAULTS = settingsFromConfig(config);

const MONTHLY: UsageSettings = {
  period: "monthly",
  limit: 2_000_000,
  reset: { weekday: 4, monthDay: 15, hour: 9, minute: 30 },
};

describe("stored settings", () => {
  it("fall back to the configured defaults while nothing is saved", () => {
    expect(DEFAULTS).toEqual({
      period: "weekly",
      limit: 500_000,
      reset: { weekday: 1, monthDay: 1, hour: 0, minute: 0 },
    });
    expect(parseStoredSettings(null, DEFAULTS)).toEqual(DEFAULTS);
    expect(resolveConfig(config, null)).toEqual(config);
  });

  it("seed the defaults from the env vars", () => {
    const seeded = settingsFromConfig(getConfig({ WEEKLY_LIMIT: "750_000", RESET_WEEKDAY: "3", RESET_TIME: "06:15" }));
    expect(seeded).toEqual({
      period: "weekly",
      limit: 750_000,
      reset: { weekday: 3, monthDay: 1, hour: 6, minute: 15 },
    });
  });

  it("survive a round trip through Redis", () => {
    const raw = serializeSettings(MONTHLY, new Date("2026-09-21T10:00:00Z"));
    expect(JSON.parse(raw)).toMatchObject({ v: 1, period: "monthly", updatedAt: 1789984800000 });
    expect(parseStoredSettings(raw, DEFAULTS)).toEqual(MONTHLY);
  });

  it("override the defaults, but never the time zone or the other configuration", () => {
    const effective = resolveConfig(config, serializeSettings(MONTHLY, new Date()));
    expect(effective.limit).toBe(2_000_000);
    expect(effective.reset).toEqual({
      period: "monthly",
      weekday: 4,
      monthDay: 15,
      hour: 9,
      minute: 30,
      timeZone: "Europe/Budapest",
    });
    expect(effective.tokenMode).toBe(config.tokenMode);
    expect(effective.retentionDays).toBe(config.retentionDays);

    const cycle = getCycle(new Date("2026-09-23T10:00:00Z"), effective.reset);
    expect(cycle.start.toISOString()).toBe("2026-09-15T07:30:00.000Z");
  });

  it("are read field by field: what does not hold up falls back to its default", () => {
    const raw = JSON.stringify({
      period: "yearly",
      limit: 1_234_567,
      reset: { weekday: 9, monthDay: 31, hour: "7", minute: 45 },
    });
    expect(parseStoredSettings(raw, DEFAULTS)).toEqual({
      period: "weekly",
      limit: 1_234_567,
      reset: { weekday: 1, monthDay: 31, hour: 0, minute: 45 },
    });
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
    limit: 2_000_000,
    reset: { weekday: 4, monthDay: 15, hour: 9, minute: 30 },
    groups: [
      { id: " Work ", color: "#3987E5" },
      { id: "Személyes", color: "#abc" },
    ],
    removedGroups: ["Old", "Old"],
  };

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

  it("treats the group lists as optional", () => {
    const { groups: _groups, removedGroups: _removed, ...budgetOnly } = valid;
    const result = parseSettingsUpdate(budgetOnly);
    expect(result.ok && result.update.groups).toEqual([]);
    expect(result.ok && result.update.removedGroups).toEqual([]);
  });

  it("defaults nothing: every budget field is required", () => {
    const result = parseSettingsUpdate({});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toHaveLength(6);
  });

  it.each([
    ["a non-object body", [valid]],
    ["an unknown period", { ...valid, period: "daily" }],
    ["a zero limit", { ...valid, limit: 0 }],
    ["a fractional limit", { ...valid, limit: 1000.5 }],
    ["a limit given as text", { ...valid, limit: "500000" }],
    ["an absurd limit", { ...valid, limit: 1e15 }],
    ["weekday 7", { ...valid, reset: { ...valid.reset, weekday: 7 } }],
    ["month day 0", { ...valid, reset: { ...valid.reset, monthDay: 0 } }],
    ["month day 32", { ...valid, reset: { ...valid.reset, monthDay: 32 } }],
    ["hour 24", { ...valid, reset: { ...valid.reset, hour: 24 } }],
    ["minute 60", { ...valid, reset: { ...valid.reset, minute: 60 } }],
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

describe("buildSettingsView", () => {
  it("lists the groups in order of first appearance, each with a colour", () => {
    const view = buildSettingsView(resolveConfig(config, serializeSettings(MONTHLY, new Date())), [
      { groupId: "Personal", color: null, firstSeenAt: 200, hasReports: true },
      { groupId: "Work", color: "#ff00aa", firstSeenAt: 100, hasReports: false },
    ]);
    expect(view).toEqual({
      settings: MONTHLY,
      timeZone: "Europe/Budapest",
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
});
