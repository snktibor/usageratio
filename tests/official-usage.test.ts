import { describe, expect, it } from "vitest";
import {
  currentOfficialEntries,
  OFFICIAL_USAGE_RAW_MAX_LENGTH,
  officialUsageField,
  parseOfficialUsageUpdate,
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
