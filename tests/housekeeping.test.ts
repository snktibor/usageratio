import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeAuditRecord } from "@/lib/api-token";
import { getConfig } from "@/lib/config";
import { getCycle } from "@/lib/cycle";
import { runHousekeeping } from "@/lib/housekeeping";
import { getRedis } from "@/lib/redis";
import { serializeGroupEntry, serializeSettings, settingsFromConfig } from "@/lib/settings";
import { useRedis } from "./helpers/redis-fixture";

/**
 * lib/housekeeping.ts prunes the index hashes (machines, providers, groups,
 * official usage) and the audit trail of entries nothing still points to, and
 * never the raw event history. These tests seed a store by hand, matching the
 * shapes lib/usage-store.ts and lib/api-token.ts write, and check the counts
 * and what survives.
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
      audit: { removed: 0 },
      dryRun: false,
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
