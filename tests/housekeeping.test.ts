import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeAuditRecord } from "@/lib/api-token";
import { getConfig } from "@/lib/config";
import { getCycle, getPreviousCycle } from "@/lib/cycle";
import { runHousekeeping } from "@/lib/housekeeping";
import { ingestReport } from "@/lib/ingest";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { restartOverride } from "@/lib/resets";
import { serializeGroupEntry, serializeSettings, settingsFromConfig } from "@/lib/settings";
import { loadHistory, saveResets } from "@/lib/usage-store";
import { useRedis } from "./helpers/redis-fixture";

/**
 * lib/housekeeping.ts prunes the index hashes (machines, providers, groups,
 * official usage, per-machine tokens) and the audit trail of entries nothing
 * still points to, and never the raw event history; its one writing step
 * archives the cycle that just ended (lib/archive.ts). These tests seed a store
 * by hand, matching the shapes lib/usage-store.ts, lib/api-token.ts and
 * lib/tokens.ts write, and check the counts and what survives.
 */

const DAY_MS = 86_400_000;
const NOW = new Date("2026-09-26T10:00:00Z");
const OLD = NOW.getTime() - 100 * DAY_MS; // well past the 70-day retention window
const RECENT = NOW.getTime() - 5 * DAY_MS; // inside the window: too new to prune

async function seedEvents(providerId: string, groupId: string, atMs = NOW.getTime()) {
  await getRedis().zadd(`usage:events:${providerId}:${groupId}`, { score: atMs, member: `seed-${atMs}` });
}

describe("runHousekeeping", () => {
  useRedis();

  beforeEach(() => {
    vi.stubEnv("AUDIT_RETENTION_DAYS", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  async function seedScenario() {
    const redis = getRedis();

    // A dead provider: old, no events, no machine, not referenced anywhere.
    await redis.hset("usage:providers", { "dead-provider": String(OLD) });
    // A provider that is old but still has stored events: survives.
    await redis.hset("usage:providers", { "active-provider": String(OLD) });
    await seedEvents("active-provider", "team", NOW.getTime());
    // A provider that is old, has no events, but a settings document still names it.
    await redis.hset("usage:providers", { "referenced-provider": String(OLD) });
    // A provider kept alive only by a recent machine.
    await redis.hset("usage:providers", { "fresh-machine-provider": String(OLD) });
    await redis.hset("usage:machines", {
      "fresh-machine-provider:m1": JSON.stringify({ g: "team", ts: RECENT, t: 10 }),
    });
    // A stale machine of the dead provider.
    await redis.hset("usage:machines", { "dead-provider:mA": JSON.stringify({ g: "team", ts: OLD, t: 5 }) });

    // Groups: one with data (survives despite being old), one empty and old (pruned), one empty but new (survives).
    await redis.hset("usage:groups", { team: serializeGroupEntry("#3987e5", OLD) });
    await redis.hset("usage:groups", { "empty-old": serializeGroupEntry("#d95926", OLD) });
    await redis.hset("usage:groups", { "empty-new": serializeGroupEntry("#199e70", RECENT) });

    // Settings document referencing "referenced-provider" (via hiddenProviders).
    await redis.set("usage:settings", JSON.stringify({ hiddenProviders: ["referenced-provider"] }));

    // Official usage: a current-cycle entry (survives), a stale-cycle one, and unparsable JSON.
    const cycle = getCycle(NOW, getConfig().reset);
    await redis.hset("usage:official", {
      "active-provider": JSON.stringify({ raw: "50", enteredAt: NOW.getTime(), cycleStartMs: cycle.start.getTime() }),
      "dead-provider": JSON.stringify({ raw: "10", enteredAt: OLD, cycleStartMs: cycle.start.getTime() - DAY_MS }),
      "referenced-provider": "not json",
    });

    // Audit trail: one recent entry, several ancient ones (older than the 365-day default).
    const record = (at: number) =>
      serializeAuditRecord({
        at,
        action: "revealed" as const,
        userAgent: "curl/8.0",
        brands: "",
        platform: "",
        ip: null,
        ipHash: "abc",
        ipPrefix: null,
        session: null,
      });
    await redis.lpush("usage:api-token:audit", record(NOW.getTime()));
    const ancient = Array.from({ length: 3 }, (_, index) => record(NOW.getTime() - (400 + index) * DAY_MS));
    await redis.rpush("usage:api-token:audit", ...ancient);

    // Per-machine tokens (lib/tokens.ts): a live one, one revoked recently (inside the
    // 90-day REVOKED_RETENTION_DAYS window), and one revoked long enough ago to forget.
    const token = (id: string, revokedAt: number | null) =>
      JSON.stringify({ id, label: id, machineId: null, createdAt: OLD, lastUsedAt: null, revokedAt });
    await redis.hset("usage:tokens", {
      "hash-live": token("tk_live0001", null),
      "hash-revoked-recent": token("tk_recent01", RECENT),
      "hash-revoked-old": token("tk_old000001", NOW.getTime() - 200 * DAY_MS),
    });

    return cycle;
  }

  it("prunes what nothing points to, and keeps what is still alive or too new to judge", async () => {
    await seedScenario();

    const report = await runHousekeeping(NOW, { dryRun: false });

    expect(report.machines).toEqual({ removed: 1, ids: ["dead-provider:mA"] });
    expect(report.providers.removed).toBe(1);
    expect(report.providers.ids).toEqual(["dead-provider"]);
    expect(report.groups).toEqual({ removed: 1, ids: ["empty-old"] });
    expect(report.officialUsage.removed).toBe(2);
    expect(report.officialUsage.ids.sort()).toEqual(["dead-provider", "referenced-provider"]);
    expect(report.tokens).toEqual({ removed: 1, ids: ["tk_old000001"] });
    expect(report.audit).toEqual({ removed: 3 });
    expect(report.dryRun).toBe(false);

    // What survived is still there.
    expect(await getRedis().hexists("usage:providers", "active-provider")).toBe(1);
    expect(await getRedis().hexists("usage:providers", "referenced-provider")).toBe(1);
    expect(await getRedis().hexists("usage:providers", "fresh-machine-provider")).toBe(1);
    expect(await getRedis().hexists("usage:groups", "team")).toBe(1);
    expect(await getRedis().hexists("usage:groups", "empty-new")).toBe(1);
    expect(await getRedis().hexists("usage:machines", "fresh-machine-provider:m1")).toBe(1);
    expect(await getRedis().hexists("usage:official", "active-provider")).toBe(1);

    // What was pruned is gone.
    expect(await getRedis().hexists("usage:providers", "dead-provider")).toBe(0);
    expect(await getRedis().hexists("usage:groups", "empty-old")).toBe(0);
    expect(await getRedis().hexists("usage:machines", "dead-provider:mA")).toBe(0);
    expect(await getRedis().hexists("usage:official", "dead-provider")).toBe(0);
    expect(await getRedis().hexists("usage:official", "referenced-provider")).toBe(0);
    expect(await getRedis().llen("usage:api-token:audit")).toBe(1);
    expect(await getRedis().hexists("usage:tokens", "hash-live")).toBe(1);
    expect(await getRedis().hexists("usage:tokens", "hash-revoked-recent")).toBe(1);
    expect(await getRedis().hexists("usage:tokens", "hash-revoked-old")).toBe(0);

    // The summary is written for the admin/cron surface to show.
    const last = JSON.parse(String(await getRedis().get("usage:housekeeping:last"))) as { at: number };
    expect(last.at).toBe(NOW.getTime());
  });

  it("dry run reports the same counts but deletes nothing", async () => {
    await seedScenario();
    const before = await getRedis()
      .pipeline()
      .hgetall("usage:providers")
      .hgetall("usage:groups")
      .hgetall("usage:machines")
      .exec();

    const report = await runHousekeeping(NOW, { dryRun: true });
    expect(report.machines.removed).toBe(1);
    expect(report.providers.removed).toBe(1);
    expect(report.groups.removed).toBe(1);
    expect(report.officialUsage.removed).toBe(2);
    expect(report.tokens.removed).toBe(1);
    expect(report.audit.removed).toBe(3);
    expect(report.dryRun).toBe(true);

    // Nothing actually changed.
    const after = await getRedis()
      .pipeline()
      .hgetall("usage:providers")
      .hgetall("usage:groups")
      .hgetall("usage:machines")
      .exec();
    expect(after).toEqual(before);
    expect(await getRedis().hexists("usage:providers", "dead-provider")).toBe(1);
    expect(await getRedis().llen("usage:api-token:audit")).toBe(4);
    expect(await getRedis().hexists("usage:tokens", "hash-revoked-old")).toBe(1);
    expect(await getRedis().exists("usage:housekeeping:last")).toBe(0);
  });

  it("is idempotent: a second run right after finds nothing left to prune", async () => {
    await seedScenario();
    await runHousekeeping(NOW, { dryRun: false });
    const second = await runHousekeeping(new Date(NOW.getTime() + 1000), { dryRun: false });

    expect(second.machines.removed).toBe(0);
    expect(second.providers.removed).toBe(0);
    expect(second.groups.removed).toBe(0);
    expect(second.officialUsage.removed).toBe(0);
    expect(second.tokens.removed).toBe(0);
    expect(second.audit.removed).toBe(0);
  });

  it("never removes a group that has any stored events, no matter how old", async () => {
    const redis = getRedis();
    await redis.hset("usage:groups", { ancient: serializeGroupEntry("#3987e5", NOW.getTime() - 1000 * DAY_MS) });
    await redis.hset("usage:providers", { p: String(NOW.getTime() - 1000 * DAY_MS) });
    await seedEvents("p", "ancient", NOW.getTime() - 999 * DAY_MS);

    const report = await runHousekeeping(NOW, { dryRun: false });
    expect(report.groups.removed).toBe(0);
    expect(await redis.hexists("usage:groups", "ancient")).toBe(1);
  });

  it("respects AUDIT_RETENTION_DAYS", async () => {
    vi.stubEnv("AUDIT_RETENTION_DAYS", "10");
    const redis = getRedis();
    const record = (at: number) =>
      serializeAuditRecord({
        at,
        action: "created" as const,
        userAgent: "",
        brands: "",
        platform: "",
        ip: null,
        ipHash: null,
        ipPrefix: null,
        session: null,
      });
    await redis.lpush("usage:api-token:audit", record(NOW.getTime()));
    await redis.rpush("usage:api-token:audit", record(NOW.getTime() - 20 * DAY_MS));

    const report = await runHousekeeping(NOW, { dryRun: false });
    expect(report.audit.removed).toBe(1);
    expect(await redis.llen("usage:api-token:audit")).toBe(1);
  });

  it("does nothing on a bare store", async () => {
    const report = await runHousekeeping(NOW, { dryRun: false });
    expect(report).toEqual({
      machines: { removed: 0, ids: [] },
      providers: { removed: 0, ids: [] },
      groups: { removed: 0, ids: [] },
      officialUsage: { removed: 0, ids: [] },
      tokens: { removed: 0, ids: [] },
      audit: { removed: 0 },
      history: { archived: 0, ids: [] },
      dryRun: false,
    });
  });

  describe("history step", () => {
    /** One report in the cycle before NOW's, through the same path a client's POST takes. */
    async function reportInPreviousCycle(providerId: string, tokens: number) {
      const cycle = getCycle(NOW, getConfig().reset);
      const previous = getPreviousCycle(cycle, getConfig().reset);
      const at = new Date(previous.start.getTime() + DAY_MS);
      const result = await ingestReport(
        {
          machineId: "mac",
          groupId: "Personal",
          providers: { [providerId]: tokens },
          timestamp: at.toISOString(),
        },
        at,
      );
      if (!result.ok) throw new Error(JSON.stringify(result));
      return { cycle, previous };
    }

    it("archives the cycle that just ended without any dashboard visit, with its official percentage", async () => {
      const { previous } = await reportInPreviousCycle("claude", 1234);
      // The previous cycle's typed-in figure: step 5 prunes it in this very run, after step 4 read it.
      await getRedis().hset("usage:official", {
        claude: JSON.stringify({ raw: "40", enteredAt: NOW.getTime(), cycleStartMs: previous.start.getTime() }),
      });

      const report = await runHousekeeping(NOW, { dryRun: false });

      expect(report.history).toEqual({ archived: 1, ids: ["claude"] });
      expect(report.officialUsage.ids).toEqual(["claude"]);
      const history = await loadHistory(["claude"]);
      expect(history.claude).toHaveLength(1);
      expect(history.claude?.[0]).toMatchObject({ start: previous.start.getTime(), total: 1234, official: 40 });
    });

    it("archives each cycle once: a second run, like a later dashboard render, finds nothing due", async () => {
      await reportInPreviousCycle("claude", 1234);
      await runHousekeeping(NOW, { dryRun: false });
      const second = await runHousekeeping(new Date(NOW.getTime() + 1000), { dryRun: false });

      expect(second.history).toEqual({ archived: 0, ids: [] });
      expect((await loadHistory(["claude"])).claude).toHaveLength(1);
    });

    it("dry run names the providers that are due but writes no history", async () => {
      await reportInPreviousCycle("claude", 1234);

      const report = await runHousekeeping(NOW, { dryRun: true });

      expect(report.history).toEqual({ archived: 1, ids: ["claude"] });
      expect((await loadHistory(["claude"])).claude ?? []).toHaveLength(0);
    });

    it("skips a provider with no events in the cycle that just ended", async () => {
      await seedEvents("claude", "Personal", NOW.getTime());
      await getRedis().hset("usage:providers", { claude: String(NOW.getTime()) });
      await getRedis().hset("usage:groups", { Personal: serializeGroupEntry("#3987e5", NOW.getTime()) });

      const report = await runHousekeeping(NOW, { dryRun: false });
      expect(report.history).toEqual({ archived: 0, ids: [] });
    });
    describe("with a provider's own reset", () => {
      // Claude resets Thursdays 09:00 UTC; the shared reset is Monday 00:00 UTC.
      const OVERRIDE_NOW = new Date("2026-09-23T12:00:00Z");

      async function seedOverride() {
        const settings = {
          ...settingsFromConfig(getConfig()),
          resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } },
        };
        await getRedis().set("usage:settings", serializeSettings(settings, OVERRIDE_NOW));
      }

      async function reportAt(providerId: string, at: string) {
        const result = await ingestReport(
          {
            machineId: "mac",
            groupId: "Personal",
            providers: { [providerId]: 100 },
            timestamp: at,
          },
          new Date(at),
        );
        if (!result.ok) throw new Error(JSON.stringify(result));
      }

      it("archives each provider's previous cycle on its own boundaries", async () => {
        await seedOverride();
        await reportAt("claude", "2026-09-12T10:00:00Z");
        await reportAt("openai", "2026-09-15T10:00:00Z");

        const report = await runHousekeeping(OVERRIDE_NOW, { dryRun: false });

        expect(report.history.ids.sort()).toEqual(["claude", "openai"]);
        const history = await loadHistory(["claude", "openai"]);
        expect(history.claude?.[0]).toMatchObject({
          start: Date.parse("2026-09-10T09:00:00Z"),
          end: Date.parse("2026-09-17T09:00:00Z"),
        });
        expect(history.openai?.[0]).toMatchObject({ start: Date.parse("2026-09-14T00:00:00Z") });
      });

      it("keeps an official entry of the provider's current cycle and drops one of its previous", async () => {
        await seedOverride();
        await getRedis().hset("usage:official", {
          claude: JSON.stringify({ raw: "40", enteredAt: 1, cycleStartMs: Date.parse("2026-09-17T09:00:00Z") }),
          "claude:sub": JSON.stringify({ raw: "30", enteredAt: 1, cycleStartMs: Date.parse("2026-09-10T09:00:00Z") }),
        });

        const report = await runHousekeeping(OVERRIDE_NOW, { dryRun: false });

        expect(report.officialUsage.ids).toEqual(["claude:sub"]);
        expect(await getRedis().hexists("usage:official", "claude")).toBe(1);
      });
    });

    it("archives a cycle a restart cut short with its real end and the restart's before-figure", async () => {
      const R = Date.parse("2026-09-24T08:00:00Z");
      const S = getCycle(new Date(R), getConfig().reset).start.getTime();
      const at = new Date(S + DAY_MS);
      const stored = await ingestReport(
        { machineId: "mac", groupId: "Personal", providers: { openai: 500 }, timestamp: at.toISOString() },
        at,
      );
      if (!stored.ok) throw new Error(JSON.stringify(stored));
      await getRedis().set(
        KEYS.settings,
        serializeSettings(
          { ...settingsFromConfig(getConfig()), resetOverrides: { openai: restartOverride(R, "UTC") } },
          NOW,
        ),
      );
      await saveResets("openai", {
        v: 1,
        events: [
          {
            id: "r",
            atMs: R,
            kind: "restart",
            cycleStartMs: S,
            before: 90,
            beforeAtMs: null,
            source: "manual",
            recordedAtMs: R,
            previousOverride: null,
          },
        ],
        autoOffCycleStartMs: null,
      });

      const report = await runHousekeeping(NOW, { dryRun: false });

      expect(report.history.ids).toContain("openai");
      expect((await loadHistory(["openai"])).openai?.[0]).toMatchObject({
        start: S,
        end: R,
        official: 90,
        endedByReset: true,
        total: 500,
      });
    });
  });

  it("uses settingsFromConfig-shaped defaults without crashing when settings hold real limits", async () => {
    // Exercises a realistic settings document (not just a bare hiddenProviders array).
    const settings = settingsFromConfig(getConfig(), ["kept-provider"]);
    await getRedis().set("usage:settings", serializeSettings(settings, NOW));
    await getRedis().hset("usage:providers", { "kept-provider": String(OLD) });

    const report = await runHousekeeping(NOW, { dryRun: false });
    expect(report.providers.ids).not.toContain("kept-provider");
    expect(await getRedis().hexists("usage:providers", "kept-provider")).toBe(1);
  });
});
