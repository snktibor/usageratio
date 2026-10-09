import { describe, expect, it } from "vitest";
import {
  type Draft,
  type DraftGroup,
  draftFrom,
  groupNameProblem,
  parseLimit,
  parseModelParts,
  parseSharePercent,
  parseTimeZone,
  patchOwnReset,
  toRequest,
  withAlertThreshold,
  withOwnReset,
} from "@/components/settings/draft";
import { getConfig } from "@/lib/config";
import { buildSettingsView, MAX_ALERT_THRESHOLDS, MAX_GROUPS, MAX_LIMIT, parseSettingsUpdate } from "@/lib/settings";
import { MAX_SUB_LIMIT_MODELS } from "@/lib/sub-limits";

/**
 * `draft.ts` is pure: no next-intl, no DOM. These tests cover its parsing and
 * validation directly, and prove `toRequest(...)` builds exactly what
 * `parseSettingsUpdate` (lib/settings.ts) accepts as a PUT body.
 */

const config = getConfig({});
const view = buildSettingsView(config, [], ["claude", "deepseek"], {
  claude: ["claude-opus-4-5", "claude-fable-5-1"],
});

function group(id: string, overrides: Partial<DraftGroup> = {}): DraftGroup {
  return { id, color: "#3987e5", colorText: "#3987e5", hasReports: false, excluded: [], ...overrides };
}

describe("parseLimit", () => {
  it("accepts a plain positive integer", () => {
    expect(parseLimit("500000")).toBe(500_000);
  });

  it("strips the separators people type while entering a large number", () => {
    expect(parseLimit("500 000")).toBe(500_000);
    expect(parseLimit("500_000")).toBe(500_000);
    expect(parseLimit("500.000")).toBe(500_000);
    expect(parseLimit("500,000")).toBe(500_000);
  });

  it("rejects zero, blank, non-numeric and negative text", () => {
    expect(parseLimit("0")).toBeNull();
    expect(parseLimit("")).toBeNull();
    expect(parseLimit("abc")).toBeNull();
    expect(parseLimit("-5")).toBeNull();
  });

  it("rejects a limit above MAX_LIMIT", () => {
    expect(parseLimit(String(MAX_LIMIT))).toBe(MAX_LIMIT);
    expect(parseLimit(String(MAX_LIMIT + 1))).toBeNull();
  });
});

describe("parseSharePercent", () => {
  it("accepts 1 to 100, with or without a percent sign", () => {
    expect(parseSharePercent("1")).toBe(1);
    expect(parseSharePercent("50")).toBe(50);
    expect(parseSharePercent("50 %")).toBe(50);
    expect(parseSharePercent("100")).toBe(100);
  });

  it("rejects 0, above 100, blank and non-numeric text", () => {
    expect(parseSharePercent("0")).toBeNull();
    expect(parseSharePercent("101")).toBeNull();
    expect(parseSharePercent("")).toBeNull();
    expect(parseSharePercent("abc")).toBeNull();
  });
});

describe("parseModelParts", () => {
  it("splits on commas, semicolons and whitespace, lower-cased", () => {
    expect(parseModelParts("Fable, Opus-5")).toEqual(["fable", "opus-5"]);
    expect(parseModelParts("fable;opus-5")).toEqual(["fable", "opus-5"]);
    expect(parseModelParts("fable opus-5")).toEqual(["fable", "opus-5"]);
  });

  it("de-duplicates parts once normalized", () => {
    expect(parseModelParts("fable, Fable, FABLE")).toEqual(["fable"]);
  });

  it("rejects an empty or blank list", () => {
    expect(parseModelParts("")).toBeNull();
    expect(parseModelParts("   ")).toBeNull();
  });

  it("rejects a part that is not a valid model-id fragment", () => {
    expect(parseModelParts("fable, $$$")).toBeNull();
  });

  it("rejects more parts than MAX_SUB_LIMIT_MODELS", () => {
    const tooMany = Array.from({ length: MAX_SUB_LIMIT_MODELS + 1 }, (_, index) => `m${index}`).join(", ");
    expect(parseModelParts(tooMany)).toBeNull();
  });
});

describe("parseTimeZone", () => {
  it("accepts a zone Intl knows, in its canonical spelling", () => {
    expect(parseTimeZone("Europe/Budapest")).toBe("Europe/Budapest");
    expect(parseTimeZone(" europe/budapest ")).toBe("Europe/Budapest");
    expect(parseTimeZone("UTC")).toBe("UTC");
  });

  it("rejects a half-typed or unknown zone", () => {
    for (const text of ["", "  ", "Europe/Buda", "Mars/Olympus_Mons"]) {
      expect(parseTimeZone(text)).toBeNull();
    }
  });
});

describe("groupNameProblem", () => {
  const groups = [group("work")];

  it("allows a new, valid name", () => {
    expect(groupNameProblem("home", groups)).toBeNull();
  });

  it("rejects an empty name", () => {
    expect(groupNameProblem("", groups)).toEqual({ code: "group_name_rules" });
    expect(groupNameProblem("   ", groups)).toEqual({ code: "group_name_rules" });
  });

  it("rejects a name with characters an id may not contain", () => {
    expect(groupNameProblem("a/b", groups)).toEqual({ code: "group_name_rules" });
  });

  it("rejects a name already on the list", () => {
    expect(groupNameProblem("work", groups)).toEqual({ code: "group_already_exists", id: "work" });
  });

  it("rejects a new group once MAX_GROUPS is reached", () => {
    const full = Array.from({ length: MAX_GROUPS }, (_, index) => group(`g${index}`));
    expect(groupNameProblem("one-more", full)).toEqual({ code: "max_groups_reached" });
  });
});

describe("toRequest", () => {
  it("builds a request parseSettingsUpdate (lib/settings.ts) accepts, from an untouched draft", () => {
    const draft = draftFrom(view);
    const result = toRequest(draft);
    if (!("request" in result)) throw new Error(`expected a request, got a problem: ${JSON.stringify(result)}`);
    expect(parseSettingsUpdate(result.request)).toMatchObject({ ok: true });
  });

  it("carries edits made on the draft through to the parsed update", () => {
    const draft = draftFrom(view);
    const edited: Draft = {
      ...draft,
      period: "monthly",
      monthDay: 15,
      useTokenLimits: true,
      providers: draft.providers.map((provider) => ({ ...provider, limitText: "1 000 000" })),
    };
    const result = toRequest(edited);
    if (!("request" in result)) throw new Error(`expected a request, got a problem: ${JSON.stringify(result)}`);
    const parsed = parseSettingsUpdate(result.request);
    if (!parsed.ok) throw new Error(`expected parseSettingsUpdate to accept it: ${parsed.errors.join("; ")}`);
    expect(parsed.update.settings.period).toBe("monthly");
    expect(parsed.update.settings.reset.monthDay).toBe(15);
    expect(parsed.update.settings.limits.claude).toBe(1_000_000);
    expect(parsed.update.settings.limits.deepseek).toBe(1_000_000);
  });

  it("refuses to save a time zone that is not a known one", () => {
    const draft = draftFrom(view);
    expect(toRequest({ ...draft, timeZone: "Europe/Buda" })).toEqual({ problem: { code: "invalid_time_zone" } });
  });

  it("saves a typed time zone in its canonical spelling", () => {
    const result = toRequest({ ...draftFrom(view), timeZone: "europe/budapest" });
    if (!("request" in result)) throw new Error(`expected a request, got a problem: ${JSON.stringify(result)}`);
    expect(result.request.reset.timeZone).toBe("Europe/Budapest");
  });

  it("reports an invalid provider limit as a DraftProblem code, not text", () => {
    const draft = draftFrom(view);
    const broken: Draft = {
      ...draft,
      useTokenLimits: true,
      providers: draft.providers.map((provider) => ({ ...provider, limitText: "not a number" })),
    };
    const result = toRequest(broken);
    expect(result).toEqual({ problem: { code: "invalid_provider_limit", label: "Claude" } });
  });

  it("reports a sub-limit without a name as a DraftProblem code", () => {
    const draft = draftFrom(view);
    const [claude, ...rest] = draft.providers;
    if (!claude) throw new Error("expected a claude provider in the fixture");
    const withUnnamedSubLimit: Draft = {
      ...draft,
      providers: [
        {
          ...claude,
          subLimits: [
            {
              id: null,
              key: "new-1",
              name: "",
              modelsText: "fable",
              mode: "separate",
              shareText: "50",
              limitText: "100000",
              savedShare: 50,
              savedLimit: 100_000,
            },
          ],
        },
        ...rest,
      ],
    };
    const result = toRequest(withUnnamedSubLimit);
    expect(result).toEqual({ problem: { code: "missing_sublimit_name", label: "Claude" } });
  });

  it("rejects an invalid group colour", () => {
    const draft = draftFrom(view);
    const withBadColor: Draft = {
      ...draft,
      groups: [group("work", { colorText: "not-a-color" })],
    };
    const result = toRequest(withBadColor);
    expect(result).toEqual({ problem: { code: "invalid_group_color", id: "work" } });
  });

  it("requires at least one visible account", () => {
    const draft = draftFrom(view);
    const allHidden: Draft = {
      ...draft,
      providers: draft.providers.map((provider) => ({ ...provider, visible: false })),
    };
    expect(toRequest(allHidden)).toEqual({ problem: { code: "at_least_one_visible_account" } });
  });

  it("turns an empty webhook field into alerts off", () => {
    const draft = draftFrom(view);
    const result = toRequest({ ...draft, alerts: { ...draft.alerts, webhookUrl: "  " } });
    if (!("request" in result)) throw new Error(`expected a request, got a problem: ${JSON.stringify(result)}`);
    expect(result.request.alerts.webhookUrl).toBeNull();
    expect(parseSettingsUpdate(result.request)).toMatchObject({ ok: true });
  });

  it("carries an edited webhook, thresholds, format and locale through to the parsed update", () => {
    const draft = draftFrom(view);
    const edited: Draft = {
      ...draft,
      alerts: {
        webhookUrl: " https://hooks.example.com/x ",
        thresholds: [90, 25, 25],
        newThreshold: "",
        perProvider: false,
        format: "discord",
        locale: "de",
      },
    };
    const result = toRequest(edited);
    if (!("request" in result)) throw new Error(`expected a request, got a problem: ${JSON.stringify(result)}`);
    const parsed = parseSettingsUpdate(result.request);
    if (!parsed.ok) throw new Error(`expected parseSettingsUpdate to accept it: ${parsed.errors.join("; ")}`);
    expect(parsed.update.settings.alerts).toEqual({
      webhookUrl: "https://hooks.example.com/x",
      thresholds: [25, 90],
      perProvider: false,
      format: "discord",
      locale: "de",
    });
  });

  it("rejects a webhook URL that fails the allow-list", () => {
    const draft = draftFrom(view);
    const withBadWebhook: Draft = { ...draft, alerts: { ...draft.alerts, webhookUrl: "https://localhost/x" } };
    expect(toRequest(withBadWebhook)).toEqual({ problem: { code: "invalid_alert_webhook" } });
  });

  it("requires at least one threshold", () => {
    const draft = draftFrom(view);
    const noThresholds: Draft = { ...draft, alerts: { ...draft.alerts, thresholds: [] } };
    expect(toRequest(noThresholds)).toEqual({ problem: { code: "alerts_need_at_least_one_threshold" } });
  });

  it("saves a threshold still left in the add field", () => {
    const draft = draftFrom(view);
    const result = toRequest({ ...draft, alerts: { ...draft.alerts, thresholds: [], newThreshold: " 85 " } });
    if (!("request" in result)) throw new Error(`expected a request, got a problem: ${JSON.stringify(result)}`);
    expect(result.request.alerts.thresholds).toEqual([85]);
  });

  it("refuses to save while the add field holds no valid percentage", () => {
    const draft = draftFrom(view);
    const result = toRequest({ ...draft, alerts: { ...draft.alerts, newThreshold: "150" } });
    expect(result).toEqual({ problem: { code: "invalid_alert_threshold" } });
  });
});

describe("withAlertThreshold", () => {
  it("adds a typed value, keeping the list sorted", () => {
    expect(withAlertThreshold([50, 100], "80")).toEqual({ thresholds: [50, 80, 100] });
    expect(withAlertThreshold([], " 7 ")).toEqual({ thresholds: [7] });
  });

  it("drops a value already on the list instead of repeating it", () => {
    expect(withAlertThreshold([50, 80, 100], "80")).toEqual({ thresholds: [50, 80, 100] });
  });

  it("takes a removed value back, in its sorted place", () => {
    const removed = [50, 80, 100].filter((value) => value !== 80);
    expect(withAlertThreshold(removed, "80")).toEqual({ thresholds: [50, 80, 100] });
  });

  it("refuses anything but a whole number from 1 to 100", () => {
    for (const text of ["", "0", "101", "12.5", "-5", "abc"]) {
      expect(withAlertThreshold([50], text)).toEqual({ problem: { code: "invalid_alert_threshold" } });
    }
  });

  it("refuses a new value once MAX_ALERT_THRESHOLDS is reached, but not a repeat", () => {
    const full = Array.from({ length: MAX_ALERT_THRESHOLDS }, (_, i) => i + 1);
    expect(withAlertThreshold(full, "60")).toEqual({ problem: { code: "max_alert_thresholds_reached" } });
    expect(withAlertThreshold(full, "5")).toEqual({ thresholds: full });
  });
});

describe("per-provider resets", () => {
  const ownView = buildSettingsView(
    {
      ...config,
      resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 5, source: "report" } },
    },
    [],
    ["claude", "openai"],
    {},
  );
  const draft = draftFrom(ownView);

  it("draftFrom turns an override into editable text, keeping its source", () => {
    expect(draft.resetOverrides).toEqual({ claude: { weekday: 4, monthDay: 1, time: "09:05", source: "report" } });
  });

  it("switching one on starts from the shared reset; switching it off removes it", () => {
    const on = withOwnReset(draft, "openai", true);
    expect(on.resetOverrides.openai).toEqual({ weekday: draft.weekday, monthDay: draft.monthDay, time: draft.time });
    expect(withOwnReset(on, "openai", false).resetOverrides).not.toHaveProperty("openai");
  });

  it("an edit drops the report's source marker", () => {
    const edited = patchOwnReset(draft, "claude", { time: "10:00" });
    expect(edited.resetOverrides.claude).toEqual({ weekday: 4, monthDay: 1, time: "10:00" });
  });

  it("toRequest sends hour and minute, with the source while it is still there", () => {
    const result = toRequest(draft);
    if (!("request" in result)) throw new Error(JSON.stringify(result.problem));
    expect(result.request.resetOverrides).toEqual({
      claude: { weekday: 4, monthDay: 1, hour: 9, minute: 5, source: "report" },
    });
  });

  it("refuses an own reset whose time is not HH:MM", () => {
    expect(toRequest(patchOwnReset(draft, "claude", { time: "9" }))).toEqual({
      problem: { code: "invalid_own_reset_time", label: "Claude" },
    });
  });
});
