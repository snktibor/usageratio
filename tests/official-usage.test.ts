import { describe, expect, it } from "vitest";
import {
  currentOfficialEntries,
  OFFICIAL_USAGE_RAW_MAX_LENGTH,
  officialUsageField,
  parseArchivedOfficialUpdate,
  parseOfficialUsageUpdate,
  parseStoredOfficialEntry,
  providerOfOfficialField,
  serializeOfficialEntry,
  storedEntryFor,
} from "@/lib/official-usage";

const CYCLE_START = Date.parse("2026-09-21T00:00:00Z");

describe("officialUsageField", () => {
  it("is the provider id alone for the provider's own figure", () => {
    expect(officialUsageField("claude", null)).toBe("claude");
  });

  it("is provider:subLimit for a sub-limit's figure", () => {
    expect(officialUsageField("claude", "fable")).toBe("claude:fable");
  });
});

describe("parseOfficialUsageUpdate", () => {
  it("accepts the provider's own field", () => {
    const result = parseOfficialUsageUpdate({
      providerId: "claude",
      subLimitId: null,
      raw: "45.5",
      cycleStartMs: CYCLE_START,
    });
    expect(result).toEqual({
      ok: true,
      update: { providerId: "claude", subLimitId: null, raw: "45.5", cycleStartMs: CYCLE_START },
    });
  });

  it("accepts a sub-limit's field, and normalizes the provider id's case", () => {
    const result = parseOfficialUsageUpdate({
      providerId: "Claude",
      subLimitId: "fable",
      raw: "10",
      cycleStartMs: CYCLE_START,
    });
    expect(result).toEqual({
      ok: true,
      update: { providerId: "claude", subLimitId: "fable", raw: "10", cycleStartMs: CYCLE_START },
    });
  });

  it("accepts an empty raw: it clears the field", () => {
    const result = parseOfficialUsageUpdate({
      providerId: "claude",
      subLimitId: null,
      raw: "",
      cycleStartMs: CYCLE_START,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a bad provider id", () => {
    const result = parseOfficialUsageUpdate({ providerId: "", subLimitId: null, raw: "1", cycleStartMs: CYCLE_START });
    expect(result).toEqual({ ok: false, errors: ["providerId must be a valid provider id"] });
  });

  it("rejects a bad sub-limit id", () => {
    const result = parseOfficialUsageUpdate({
      providerId: "claude",
      subLimitId: "Not Valid!",
      raw: "1",
      cycleStartMs: CYCLE_START,
    });
    expect(result).toEqual({ ok: false, errors: ["subLimitId must be a valid sub-limit id, or null"] });
  });

  it("rejects raw text past the length limit", () => {
    const result = parseOfficialUsageUpdate({
      providerId: "claude",
      subLimitId: null,
      raw: "1".repeat(OFFICIAL_USAGE_RAW_MAX_LENGTH + 1),
      cycleStartMs: CYCLE_START,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-finite cycleStartMs", () => {
    const result = parseOfficialUsageUpdate({ providerId: "claude", subLimitId: null, raw: "1", cycleStartMs: NaN });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(parseOfficialUsageUpdate(null)).toEqual({ ok: false, errors: ["body must be an object"] });
    expect(parseOfficialUsageUpdate("nope")).toEqual({ ok: false, errors: ["body must be an object"] });
  });

  it("collects every problem at once", () => {
    const result = parseOfficialUsageUpdate({ providerId: 5, subLimitId: 5, raw: 5, cycleStartMs: "x" });
    expect(result).toEqual({
      ok: false,
      errors: [
        "providerId must be a valid provider id",
        "subLimitId must be a valid sub-limit id, or null",
        `raw must be a string of at most ${OFFICIAL_USAGE_RAW_MAX_LENGTH} characters`,
        "cycleStartMs must be a finite number",
      ],
    });
  });
});

describe("storedEntryFor / currentOfficialEntries — round trip", () => {
  it("stores and reads back a figure typed in the current cycle", () => {
    const update = parseOfficialUsageUpdate({
      providerId: "claude",
      subLimitId: null,
      raw: "45.5",
      cycleStartMs: CYCLE_START,
    });
    if (!update.ok) throw new Error("expected a valid update");
    const stored = storedEntryFor(update.update, 1_700_000_000_000);
    expect(stored).not.toBeNull();

    const entries = currentOfficialEntries({ claude: stored! }, CYCLE_START);
    expect(entries.get("claude")).toEqual({ raw: "45.5", enteredAt: 1_700_000_000_000 });
  });

  it("an empty raw clears the field: nothing to store", () => {
    const update = parseOfficialUsageUpdate({
      providerId: "claude",
      subLimitId: null,
      raw: "",
      cycleStartMs: CYCLE_START,
    });
    if (!update.ok) throw new Error("expected a valid update");
    expect(storedEntryFor(update.update, 1_700_000_000_000)).toBeNull();
  });

  it("drops an entry typed in a cycle that has since rolled over", () => {
    const stored = serializeOfficialEntry({ raw: "45.5", enteredAt: 1_700_000_000_000, cycleStartMs: CYCLE_START });
    const entries = currentOfficialEntries({ claude: stored }, CYCLE_START + 7 * 86_400_000);
    expect(entries.has("claude")).toBe(false);
  });

  it("drops a field that is not valid JSON, or not shaped like an entry", () => {
    const entries = currentOfficialEntries(
      { claude: "not json", openai: "42", deepseek: JSON.stringify({ raw: "1" }) },
      CYCLE_START,
    );
    expect(entries.size).toBe(0);
  });

  it("keeps a provider's field and one of its sub-limits' apart", () => {
    const providerEntry = serializeOfficialEntry({ raw: "80", enteredAt: 1, cycleStartMs: CYCLE_START });
    const subEntry = serializeOfficialEntry({ raw: "20", enteredAt: 2, cycleStartMs: CYCLE_START });
    const entries = currentOfficialEntries(
      { [officialUsageField("claude", null)]: providerEntry, [officialUsageField("claude", "fable")]: subEntry },
      CYCLE_START,
    );
    expect(entries.get("claude")).toEqual({ raw: "80", enteredAt: 1 });
    expect(entries.get("claude:fable")).toEqual({ raw: "20", enteredAt: 2 });
  });
});

describe("currentOfficialEntries — per provider", () => {
  it("checks each field against its own provider's cycle start", () => {
    const CLAUDE_START = Date.parse("2026-09-17T09:00:00Z");
    const stored = {
      claude: serializeOfficialEntry({ raw: "41", enteredAt: 1, cycleStartMs: CLAUDE_START }),
      "claude:fable": serializeOfficialEntry({ raw: "12", enteredAt: 2, cycleStartMs: CLAUDE_START }),
      openai: serializeOfficialEntry({ raw: "30", enteredAt: 3, cycleStartMs: CLAUDE_START }),
    };
    const startOf = (providerId: string) => (providerId === "claude" ? CLAUDE_START : CYCLE_START);
    const entries = currentOfficialEntries(stored, startOf);
    expect([...entries.keys()].sort()).toEqual(["claude", "claude:fable"]);
  });
});

describe("providerOfOfficialField", () => {
  it("reads the provider id off a provider's or a sub-limit's field", () => {
    expect(providerOfOfficialField("claude")).toBe("claude");
    expect(providerOfOfficialField("claude:fable")).toBe("claude");
  });
});

describe("parseArchivedOfficialUpdate", () => {
  it("reads the typed text as a percentage", () => {
    expect(parseArchivedOfficialUpdate({ providerId: "Claude", raw: "100", cycleStartMs: CYCLE_START })).toEqual({
      ok: true,
      update: { providerId: "claude", cycleStartMs: CYCLE_START, official: 100 },
    });
    const comma = parseArchivedOfficialUpdate({ providerId: "claude", raw: "82,5 %", cycleStartMs: CYCLE_START });
    expect(comma.ok && comma.update.official).toBe(82.5);
  });

  it("reads an empty text as clearing the figure", () => {
    const parsed = parseArchivedOfficialUpdate({ providerId: "claude", raw: " ", cycleStartMs: CYCLE_START });
    expect(parsed).toEqual({ ok: true, update: { providerId: "claude", cycleStartMs: CYCLE_START, official: null } });
  });

  it("rejects a figure outside 0–100, a bad provider and a missing cycle", () => {
    const parsed = parseArchivedOfficialUpdate({ providerId: "", raw: "120", cycleStartMs: "x" });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors).toHaveLength(3);
    expect(parseArchivedOfficialUpdate({ providerId: "claude", raw: 100, cycleStartMs: CYCLE_START }).ok).toBe(false);
    expect(parseArchivedOfficialUpdate(null).ok).toBe(false);
  });
});

describe("a report's window reset on a stored entry", () => {
  it("is stored with a report's figure and read back; a typed figure has none", () => {
    const fromReport = storedEntryFor(
      { providerId: "claude", subLimitId: null, raw: "41.2", cycleStartMs: 100, resetsAtMs: 900 },
      50,
    )!;
    expect(parseStoredOfficialEntry(fromReport)).toEqual({
      view: { raw: "41.2", enteredAt: 50 },
      cycleStartMs: 100,
      resetsAtMs: 900,
    });
    const typed = storedEntryFor({ providerId: "claude", subLimitId: null, raw: "45", cycleStartMs: 100 }, 60)!;
    expect(parseStoredOfficialEntry(typed)).toEqual({ view: { raw: "45", enteredAt: 60 }, cycleStartMs: 100 });
  });

  it("is never taken from the dashboard's PUT body", () => {
    const parsed = parseOfficialUsageUpdate({
      providerId: "claude",
      subLimitId: null,
      raw: "45",
      cycleStartMs: 100,
      resetsAtMs: 900,
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.update).not.toHaveProperty("resetsAtMs");
  });
});
