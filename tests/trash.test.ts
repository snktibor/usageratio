import { describe, expect, it, vi } from "vitest";
import { archiveBeforeChange } from "@/lib/archive";
import type { CycleSummary } from "@/lib/history";
import { ingestReport } from "@/lib/ingest";
import { log } from "@/lib/log";
import { deleteGroup, deleteProvider } from "@/lib/manage-store";
import { officialUsageField } from "@/lib/official-usage";
import { getRedis } from "@/lib/redis";
import { PRESET_COLORS, serializeGroupEntry } from "@/lib/settings";
import {
  groupSettingsParts,
  listTrash,
  newTrashId,
  parseTrashMeta,
  providerSettingsParts,
  purgeTrash,
  restoreTrash,
  TRASH_ID_PATTERN,
  TRASH_LIST_LIMIT,
  TRASH_RETENTION_DAYS,
  type TrashMeta,
  trimTrash,
  withRestoredSettings,
} from "@/lib/trash";
import { archiveCycle, loadAllTime, loadHistory, saveArchivedOfficial, saveResets } from "@/lib/usage-store";
import { manageTrail, stubAudit } from "./helpers/manage-audit";
import { useRedis } from "./helpers/redis-fixture";
import { KEYS, tenant } from "./helpers/tenant";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-09-23T00:00:00Z");
/** The weekly cycle NOW falls in starts on Monday. */
const CYCLE_START_MS = Date.parse("2026-09-21T00:00:00Z");

async function ingest(body: Record<string, unknown>, now = NOW) {
  const result = await ingestReport(
    tenant,
    { machineId: "mac", groupId: "Personal", providers: { claude: 100 }, timestamp: now.toISOString(), ...body },
    now,
  );
  if (!result.ok) throw new Error("errors" in result ? result.errors.join("; ") : JSON.stringify(result));
  return result;
}

async function members(key: string): Promise<{ member: string; score: number }[]> {
  const raw = await getRedis().zrange<string[]>(key, 0, -1, { withScores: true });
  const list: { member: string; score: number }[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) list.push({ member: String(raw[i]), score: Number(raw[i + 1]) });
  return list;
}

/** Force-deletes a group and returns its trash id. */
async function trashGroup(groupId: string, now = NOW, audit = stubAudit().audit): Promise<string> {
  const result = await deleteGroup(tenant, groupId, true, now, { audit });
  if (!result.ok || !result.trashId) throw new Error(`not trashed: ${JSON.stringify(result)}`);
  return result.trashId;
}

async function trashProvider(providerId: string, now = NOW): Promise<string> {
  const result = await deleteProvider(tenant, providerId, true, now, { audit: stubAudit().audit });
  if (!result.ok || !result.trashId) throw new Error(`not trashed: ${JSON.stringify(result)}`);
  return result.trashId;
}

const registry = async () => ((await getRedis().smembers(KEYS.registry)) as unknown[]).map(String);

describe("a forced delete moves into the trash", () => {
  useRedis();

  it("renames the events keys, keeps the members, expires everything in 30 days and registers every name", async () => {
    await getRedis().set(KEYS.settings, JSON.stringify({ excludedProviders: { Work: ["openai"] } }));
    await ingest({ groupId: "Work", machineId: "mac1", mode: "manual", providers: { claude: 100, openai: 50 } });
    await ingest({ groupId: "Work", machineId: "mac2", intervalMinutes: 30, providers: { claude: 20 } });
    const before = {
      claude: await members(KEYS.events("claude", "Work")),
      openai: await members(KEYS.events("openai", "Work")),
    };
    const rawMac1 = await getRedis().hget<string>(KEYS.machines, "claude:mac1");
    const rawGroup = await getRedis().hget<string>(KEYS.groups, "Work");
    const { audit } = stubAudit();

    const result = await deleteGroup(tenant, "Work", true, NOW, { audit });
    expect(result).toMatchObject({ ok: true, affected: { events: 3, machines: 3, groups: 1 } });
    const id = (result as { trashId?: string }).trashId!;
    expect(id).toMatch(TRASH_ID_PATTERN);

    // The live keys are gone, the trash keys hold the very same members.
    expect(await getRedis().exists(KEYS.events("claude", "Work"), KEYS.events("openai", "Work"))).toBe(0);
    expect(await members(KEYS.trashEvents(id, "claude", "Work"))).toEqual(before.claude);
    expect(await members(KEYS.trashEvents(id, "openai", "Work"))).toEqual(before.openai);
    for (const key of [KEYS.trashEntry(id), KEYS.trashEvents(id, "claude", "Work")]) {
      const ttl = await getRedis().ttl(key);
      expect(ttl).toBeGreaterThan(TRASH_RETENTION_DAYS * 86_400 - 60);
      expect(ttl).toBeLessThanOrEqual(TRASH_RETENTION_DAYS * 86_400);
    }
    expect(Number(await getRedis().zscore(KEYS.trash, id))).toBe(NOW.getTime());

    // Every name is registered, in the delete's own transaction.
    const names = await registry();
    expect(names).toEqual(
      expect.arrayContaining([
        KEYS.trashEntry(id),
        KEYS.trashEvents(id, "claude", "Work"),
        KEYS.trashEvents(id, "openai", "Work"),
      ]),
    );

    // The meta keeps the bytes of what the delete removed besides the events.
    const meta = parseTrashMeta(await getRedis().get(KEYS.trashEntry(id)))!;
    expect(meta).toMatchObject({
      kind: "group",
      id,
      name: "Work",
      at: NOW.getTime(),
      by: null,
      n: { events: 3, machines: 3, groups: 1 },
      group: rawGroup,
      excluded: ["openai"],
    });
    expect(meta.machines["claude:mac1"]).toBe(rawMac1);
    expect(JSON.parse(meta.machines["claude:mac1"]!).md).toBe("manual");
    expect(meta.keys).toEqual([
      { p: "claude", g: "Work", n: 2 },
      { p: "openai", g: "Work", n: 1 },
    ]);

    // The live side lost its entries and exclusion; the trail names the entry.
    expect(await getRedis().hexists(KEYS.groups, "Work")).toBe(0);
    expect(await getRedis().hlen(KEYS.machines)).toBe(0);
    expect((await manageTrail())[0]).toMatchObject({ action: "group_deleted", trashId: id });
  });

  it("does not trash a group without stored reports, nor a refused delete, nor a dry run", async () => {
    await ingest({ groupId: "Quiet", providers: {} });
    await ingest({ groupId: "Work" });

    expect(await deleteGroup(tenant, "Work", false, NOW)).toEqual({ ok: false, reason: "has_events" });
    expect(await deleteGroup(tenant, "Work", true, NOW, { dryRun: true })).not.toHaveProperty("trashId");
    const quiet = await deleteGroup(tenant, "Quiet", true, NOW);
    expect(quiet).toMatchObject({ ok: true });
    expect(quiet).not.toHaveProperty("trashId");
    expect(await getRedis().exists(KEYS.trash)).toBe(0);
    expect(await listTrash(tenant)).toEqual([]);
  });

  it("leaves out a machine entry that is gone by the time the delete reads it", async () => {
    await ingest({ groupId: "Work" });
    await ingest({ groupId: "Work", machineId: "gone" });
    // The entry disappears between the index read and the delete's own read of the raw entries.
    const pipeline = tenant.redis.pipeline.bind(tenant.redis);
    const spy = vi.spyOn(tenant.redis, "pipeline").mockImplementation(() => {
      const reads = pipeline();
      const hget = reads.hget.bind(reads);
      reads.hget = ((key: string, field: string) =>
        hget(key, field === "claude:gone" ? "claude:never-reported" : field)) as typeof reads.hget;
      return reads;
    });
    const id = await trashGroup("Work");
    spy.mockRestore();

    const meta = parseTrashMeta(await getRedis().get(KEYS.trashEntry(id)))!;
    expect(Object.keys(meta.machines)).toEqual(["claude:mac"]);
  });

  it("records the login the audit entry names", async () => {
    await ingest({ groupId: "Work" });
    const audit = async (detail: { action: string; trashId?: string }) =>
      JSON.stringify({ at: 1, a: detail.action, k: "group", id: "Work", by: "alice", tr: detail.trashId });

    const result = await deleteGroup(tenant, "Work", true, NOW, { audit: audit as never });
    const meta = parseTrashMeta(await getRedis().get(KEYS.trashEntry((result as { trashId: string }).trashId)))!;
    expect(meta.by).toBe("alice");
  });

  it.each([
    ["a coloured one", serializeGroupEntry("#3987e5", 7), "#3987e5"],
    ["a pre-colour one", "7", null],
  ])("rebuilds the group entry from the index when its raw field is gone (%s)", async (_name, raw, color) => {
    await ingest({ groupId: "Work" });
    await getRedis().hset(KEYS.groups, { Work: raw });
    const hget = vi.spyOn(getRedis(), "hget").mockResolvedValueOnce(null);

    const result = await deleteGroup(tenant, "Work", true, NOW);
    hget.mockRestore();
    const meta = parseTrashMeta(await getRedis().get(KEYS.trashEntry((result as { trashId: string }).trashId)))!;
    const entry = JSON.parse(meta.kind === "group" ? meta.group : "{}");
    expect(entry.ts).toBe(7);
    expect(entry.color).toEqual(color ?? expect.stringMatching(/^#[0-9a-f]{6}$/));
  });

  it("moves a provider's events, official figures, resets and settings parts", async () => {
    await getRedis().set(
      KEYS.settings,
      JSON.stringify({
        limits: { claude: 500_000, openai: 9 },
        subLimits: { claude: [{ id: "fable", name: "Fable" }] },
        hiddenProviders: ["claude"],
        excludedProviders: { Work: ["claude"], Solo: ["claude", "openai"] },
      }),
    );
    await getRedis().hset(KEYS.officialUsage, {
      [officialUsageField("claude", null)]: JSON.stringify({ raw: "10", enteredAt: 0, cycleStartMs: 0 }),
      [officialUsageField("claude", "fable")]: JSON.stringify({ raw: "5", enteredAt: 0, cycleStartMs: 0 }),
      [officialUsageField("openai", null)]: JSON.stringify({ raw: "7", enteredAt: 0, cycleStartMs: 0 }),
    });
    await ingest({ groupId: "Work", machineId: "m1", providers: { claude: 100 } });
    await ingest({ groupId: "Solo", machineId: "m2", providers: { claude: 200, openai: 5 } });
    await saveResets(tenant, "claude", { v: 1, events: [], autoOffCycleStartMs: CYCLE_START_MS });
    const rawResets = await getRedis().hget<string>(KEYS.resets, "claude");
    const firstSeen = Number(await getRedis().hget(KEYS.providers, "claude"));

    const id = await trashProvider("claude");

    const meta = parseTrashMeta(await getRedis().get(KEYS.trashEntry(id)))!;
    expect(meta).toMatchObject({
      kind: "provider",
      name: "claude",
      n: { events: 2, machines: 2, groups: 2 },
      firstSeen,
      resets: rawResets,
      limit: 500_000,
      subLimits: [{ id: "fable", name: "Fable" }],
      hidden: true,
      excludedIn: ["Work", "Solo"],
    });
    expect(Object.keys((meta as { official: object }).official).sort()).toEqual(["claude", "claude:fable"]);
    expect(meta.keys.map((key) => key.g).sort()).toEqual(["Solo", "Work"]);
    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
    expect(await members(KEYS.trashEvents(id, "claude", "Solo"))).toHaveLength(1);
    expect((await manageTrail())[0]).toMatchObject({ action: "provider_deleted", trashId: id });
  });

  it("does not trash a provider without stored reports", async () => {
    await ingest({});
    await getRedis().del(KEYS.events("claude", "Personal"));
    const result = await deleteProvider(tenant, "claude", true, NOW);
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty("trashId");
    expect(await listTrash(tenant)).toEqual([]);
  });
});

describe("restoreTrash", () => {
  const redis = useRedis();

  it("puts a deleted group back where nothing was re-created: members, expiry, entries, exclusions, and out of the trash", async () => {
    await getRedis().set(KEYS.settings, JSON.stringify({ excludedProviders: { Work: ["openai"] } }));
    await ingest({ groupId: "Work", machineId: "mac1", mode: "manual", providers: { claude: 100, openai: 50 } });
    await ingest({ groupId: "Work", machineId: "mac2", intervalMinutes: 30, providers: { claude: 20 } });
    const before = {
      claude: await members(KEYS.events("claude", "Work")),
      openai: await members(KEYS.events("openai", "Work")),
    };
    const machines = await getRedis().hgetall(KEYS.machines);
    const rawGroup = await getRedis().hget<string>(KEYS.groups, "Work");
    const id = await trashGroup("Work");
    const { audit } = stubAudit();

    const result = await restoreTrash(tenant, id, NOW, { audit });
    expect(result).toEqual({
      ok: true,
      kind: "group",
      id: "Work",
      restored: { events: 3, machines: 3 },
      merged: false,
      group: { id: "Work", color: JSON.parse(rawGroup!).color, excluded: ["openai"] },
    });

    expect(await members(KEYS.events("claude", "Work"))).toEqual(before.claude);
    expect(await members(KEYS.events("openai", "Work"))).toEqual(before.openai);
    const ttl = await getRedis().ttl(KEYS.events("claude", "Work"));
    expect(ttl).toBeGreaterThan(71 * 86_400 - 60);
    expect(ttl).toBeLessThanOrEqual(71 * 86_400);
    expect(await getRedis().hgetall(KEYS.machines)).toEqual(machines);
    expect(await getRedis().hget(KEYS.groups, "Work")).toBe(rawGroup);
    expect(JSON.parse((await getRedis().get<string>(KEYS.settings))!).excludedProviders).toEqual({ Work: ["openai"] });

    // Nothing is left of the entry: meta, trash keys, index entry, registry names.
    expect(await getRedis().exists(KEYS.trashEntry(id), KEYS.trashEvents(id, "claude", "Work"))).toBe(0);
    expect(await getRedis().zscore(KEYS.trash, id)).toBeNull();
    expect((await registry()).filter((name) => name.includes(":trash:"))).toEqual([]);
    expect(await registry()).toEqual(
      expect.arrayContaining([KEYS.events("claude", "Work"), KEYS.events("openai", "Work")]),
    );
    const trail = await manageTrail();
    expect(trail.map((entry) => entry.action)).toEqual(["trash_restored", "group_deleted"]);
    expect(trail[0]).toMatchObject({
      action: "trash_restored",
      subject: { kind: "group", id: "Work" },
      trashId: id,
      rederived: 0,
    });
    expect(await listTrash(tenant)).toEqual([]);
  });

  it("joins a group re-created since: both reports are there, the live colour and machine entry win", async () => {
    const t1 = new Date(NOW.getTime() - 3_600_000);
    await ingest({ groupId: "Work", machineId: "mac1", providers: { claude: 100 } }, t1);
    const id = await trashGroup("Work");
    // A report since re-creates the group, with a colour of its own, and its machine entry.
    const t2 = new Date(NOW.getTime() + 3_600_000);
    await ingest({ groupId: "Work", machineId: "mac1", providers: { claude: 150 } }, t2);
    const liveGroup = await getRedis().hget<string>(KEYS.groups, "Work");
    const liveMachine = await getRedis().hget<string>(KEYS.machines, "claude:mac1");
    const trashedGroup = (parseTrashMeta(await getRedis().get(KEYS.trashEntry(id))) as { group: string }).group;
    expect(liveGroup).not.toBe(trashedGroup);

    const result = await restoreTrash(tenant, id, t2);
    expect(result).toMatchObject({ ok: true, merged: true, restored: { events: 1, machines: 0 } });

    expect((await members(KEYS.events("claude", "Work"))).map((entry) => entry.score)).toEqual([
      t1.getTime(),
      t2.getTime(),
    ]);
    expect(await getRedis().hget(KEYS.groups, "Work")).toBe(liveGroup);
    expect(await getRedis().hget(KEYS.machines, "claude:mac1")).toBe(liveMachine);
    expect((result as { group: { color: string } }).group.color).toBe(JSON.parse(liveGroup!).color);
  });

  it("collapses a report present in both, and keeps the live key's own newer ones", async () => {
    await ingest({ groupId: "Work", machineId: "mac1" });
    const id = await trashGroup("Work");
    await ingest({ groupId: "Work", machineId: "mac1" });
    const live = await members(KEYS.events("claude", "Work"));
    expect(live).toHaveLength(1);

    expect(await restoreTrash(tenant, id, NOW)).toMatchObject({ ok: true, merged: true });
    expect(await members(KEYS.events("claude", "Work"))).toEqual(live);
  });

  it("drops reports older than the retention, as a report would", async () => {
    await ingest({ groupId: "Work", machineId: "mac1" });
    const old = JSON.stringify({ m: "mac1", t: 5, ts: NOW.getTime() - 60 * DAY_MS });
    await getRedis().zadd(KEYS.events("claude", "Work"), { score: NOW.getTime() - 60 * DAY_MS, member: old });
    const id = await trashGroup("Work");

    // 20 days later the 60-day-old report is 80 days old: past the 70-day retention.
    const later = new Date(NOW.getTime() + 20 * DAY_MS);
    const result = await restoreTrash(tenant, id, later);
    expect(result).toMatchObject({ ok: true, restored: { events: 1 } });
    expect((await members(KEYS.events("claude", "Work"))).map((entry) => entry.member)).not.toContain(old);
    expect(await members(KEYS.events("claude", "Work"))).toHaveLength(1);
  });

  it("restores a key whose reports are all past the retention as nothing at all", async () => {
    await ingest({ groupId: "Work", machineId: "mac1" });
    const id = await trashGroup("Work");
    const result = await restoreTrash(tenant, id, new Date(NOW.getTime() + 100 * DAY_MS));
    expect(result).toMatchObject({ ok: true, restored: { events: 0 } });
    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
    expect(await getRedis().exists(KEYS.trashEntry(id))).toBe(0);
  });

  it("restores a group's events but not the machine entries of a provider that is gone", async () => {
    await ingest({ groupId: "Work", machineId: "mac1", providers: { claude: 100, openai: 50 } });
    const id = await trashGroup("Work");
    // openai was deleted since (nothing stored under it any more, so it is not trashed).
    await getRedis().hdel(KEYS.providers, "openai");

    const result = await restoreTrash(tenant, id, NOW);
    expect(result).toMatchObject({ ok: true, restored: { events: 2, machines: 1 } });
    expect(await getRedis().exists(KEYS.events("openai", "Work"))).toBe(1);
    expect(await getRedis().hexists(KEYS.machines, "openai:mac1")).toBe(0);
    expect(await getRedis().hexists(KEYS.machines, "claude:mac1")).toBe(1);
    expect(await getRedis().hexists(KEYS.providers, "openai")).toBe(0);
  });

  it("restores a provider with its index entry, official figures, resets and settings parts", async () => {
    await getRedis().set(
      KEYS.settings,
      JSON.stringify({
        limits: { claude: 500_000 },
        subLimits: { claude: [{ id: "fable", name: "Fable" }] },
        hiddenProviders: ["claude"],
        excludedProviders: { Work: ["claude"], Solo: ["claude"] },
      }),
    );
    await getRedis().hset(KEYS.officialUsage, {
      [officialUsageField("claude", null)]: JSON.stringify({ raw: "10", enteredAt: 0, cycleStartMs: 0 }),
      [officialUsageField("claude", "fable")]: JSON.stringify({ raw: "5", enteredAt: 0, cycleStartMs: 0 }),
    });
    await ingest({ groupId: "Work", machineId: "m1", mode: "manual", providers: { claude: 100 } });
    await ingest({ groupId: "Solo", machineId: "m2", providers: { claude: 200 } });
    await saveResets(tenant, "claude", { v: 1, events: [], autoOffCycleStartMs: CYCLE_START_MS });
    const snapshot = async () => ({
      providers: await getRedis().hgetall(KEYS.providers),
      machines: await getRedis().hgetall(KEYS.machines),
      official: await getRedis().hgetall(KEYS.officialUsage),
      resets: await getRedis().hgetall(KEYS.resets),
      solo: await members(KEYS.events("claude", "Solo")),
    });
    const before = await snapshot();
    const id = await trashProvider("claude");
    // Solo was deleted since (nothing was stored under it any more), so its exclusion has nowhere to go.
    await getRedis().hdel(KEYS.groups, "Solo");

    const result = await restoreTrash(tenant, id, NOW, { audit: stubAudit().audit });
    expect(result).toEqual({
      ok: true,
      kind: "provider",
      id: "claude",
      restored: { events: 2, machines: 2 },
      merged: false,
    });
    expect(await snapshot()).toEqual(before);
    const settings = JSON.parse((await getRedis().get<string>(KEYS.settings))!);
    expect(settings.limits).toEqual({ claude: 500_000 });
    expect(settings.subLimits).toEqual({ claude: [{ id: "fable", name: "Fable" }] });
    expect(settings.hiddenProviders).toEqual(["claude"]);
    expect(settings.excludedProviders).toEqual({ Work: ["claude"] });
    expect((await manageTrail())[0]).toMatchObject({ action: "trash_restored", subject: { kind: "provider" } });
  });

  it("keeps what a provider has live: its official figure, its limit, and a switched-on provider stays on", async () => {
    await getRedis().set(
      KEYS.settings,
      JSON.stringify({ limits: { claude: 500_000 }, hiddenProviders: ["claude"], excludedProviders: {} }),
    );
    await getRedis().hset(KEYS.officialUsage, {
      [officialUsageField("claude", null)]: JSON.stringify({ raw: "10", enteredAt: 0, cycleStartMs: 0 }),
    });
    await ingest({ groupId: "Work", machineId: "m1", providers: { claude: 100 } });
    const id = await trashProvider("claude");

    // The provider is re-created by a report, switched on, given another limit and a newer figure.
    await ingest({ groupId: "Work", machineId: "m1", providers: { claude: 300 } }, new Date(NOW.getTime() + 60_000));
    await getRedis().set(KEYS.settings, JSON.stringify({ limits: { claude: 123 }, hiddenProviders: [] }));
    const live = JSON.stringify({ raw: "99", enteredAt: 1, cycleStartMs: 0 });
    await getRedis().hset(KEYS.officialUsage, { [officialUsageField("claude", null)]: live });

    const result = await restoreTrash(tenant, id, new Date(NOW.getTime() + 60_000));
    expect(result).toMatchObject({ ok: true, merged: true });
    const settings = JSON.parse((await getRedis().get<string>(KEYS.settings))!);
    expect(settings.limits).toEqual({ claude: 123 });
    expect(settings.hiddenProviders).toEqual([]);
    expect(await getRedis().hget(KEYS.officialUsage, officialUsageField("claude", null))).toBe(live);
    expect(await members(KEYS.events("claude", "Work"))).toHaveLength(2);
  });

  it("refuses past the caps, writing nothing and keeping the entry", async () => {
    await ingest({ groupId: "Work", machineId: "m1" });
    const groupId = await trashGroup("Work");
    for (let i = 0; i < 50; i += 1) {
      await getRedis().hset(KEYS.groups, { [`g${i}`]: serializeGroupEntry("#3987e5", 1) });
    }
    expect(await restoreTrash(tenant, groupId, NOW)).toEqual({ ok: false, reason: "too_many_groups" });
    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
    expect(await getRedis().exists(KEYS.trashEntry(groupId))).toBe(1);
    await getRedis().del(KEYS.groups);

    await ingest({ groupId: "Home", machineId: "m2", providers: { openai: 5 } });
    const providerId = await trashProvider("openai");
    for (let i = 0; i < 20; i += 1) await getRedis().hset(KEYS.providers, { [`prov${i}`]: "1" });
    expect(await restoreTrash(tenant, providerId, NOW)).toEqual({ ok: false, reason: "too_many_providers" });
    expect(await getRedis().exists(KEYS.trashEntry(providerId))).toBe(1);
    await getRedis().del(KEYS.providers);

    for (let i = 0; i < 200; i += 1) {
      await getRedis().hset(KEYS.machines, { [`claude:box${i}`]: JSON.stringify({ g: "Z", ts: 1, t: 1 }) });
    }
    expect(await restoreTrash(tenant, groupId, NOW)).toEqual({ ok: false, reason: "too_many_machines" });
    expect(await getRedis().exists(KEYS.trashEntry(groupId))).toBe(1);
  });

  it("answers not_found for an unknown id, an expired entry and an unreadable meta", async () => {
    expect(await restoreTrash(tenant, newTrashId(), NOW)).toEqual({ ok: false, reason: "not_found" });

    await ingest({ groupId: "Work", machineId: "m1" });
    const id = await trashGroup("Work");
    const other = newTrashId();
    const meta = (await getRedis().get<string>(KEYS.trashEntry(id)))!;
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    // A document that names another id would put the keys under the wrong names.
    await getRedis().set(KEYS.trashEntry(other), meta);
    expect(await restoreTrash(tenant, other, NOW)).toEqual({ ok: false, reason: "not_found" });
    await getRedis().set(KEYS.trashEntry(other), "{not json");
    expect(await restoreTrash(tenant, other, NOW)).toEqual({ ok: false, reason: "not_found" });
    expect(warn).toHaveBeenCalledWith("trash.meta_unreadable", { trashId: other });
    warn.mockRestore();

    if (redis.store) {
      redis.store.clock.advance(31 * DAY_MS);
      expect(await restoreTrash(tenant, id, NOW)).toEqual({ ok: false, reason: "not_found" });
      expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
    }
  });

  it("restores what is left of an entry whose events keys have expired, and one that holds none", async () => {
    await ingest({ groupId: "Work", machineId: "m1" });
    const id = await trashGroup("Work");
    await getRedis().del(KEYS.trashEvents(id, "claude", "Work"));
    expect(await restoreTrash(tenant, id, NOW)).toMatchObject({ ok: true, restored: { events: 0, machines: 1 } });
    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
    expect(await getRedis().hexists(KEYS.groups, "Work")).toBe(1);

    const bare = {
      v: 1,
      kind: "group",
      id: "BBBBBBBBBBBBBBBB",
      name: "Lab",
      at: 1,
      n: { e: 0, m: 0, g: 1 },
      keys: [],
      machines: {},
      group: serializeGroupEntry("#3987e5", 1),
    };
    await getRedis().set(KEYS.trashEntry("BBBBBBBBBBBBBBBB"), JSON.stringify(bare));
    expect(await restoreTrash(tenant, "BBBBBBBBBBBBBBBB", NOW)).toMatchObject({
      ok: true,
      restored: { events: 0, machines: 0 },
      group: { id: "Lab", color: "#3987e5" },
    });
    expect(await getRedis().hexists(KEYS.groups, "Lab")).toBe(1);
  });

  it("answers with a preset colour for a pre-colour group entry, trashed or live", async () => {
    await getRedis().hset(KEYS.groups, { Work: "5" });
    await ingest({ groupId: "Work", machineId: "m1" });
    await getRedis().hset(KEYS.groups, { Work: "5" });
    const id = await trashGroup("Work");
    const trashed = await restoreTrash(tenant, id, NOW);
    expect(trashed).toMatchObject({ ok: true, group: { color: PRESET_COLORS[0] } });

    // Live, and pre-colour as well: the trashed entry's colour is used.
    await ingest({ groupId: "Home", machineId: "m2" });
    const second = await trashGroup("Home");
    await getRedis().hset(KEYS.groups, { Home: "5" });
    expect(await restoreTrash(tenant, second, NOW)).toMatchObject({
      ok: true,
      merged: true,
      group: { color: expect.stringMatching(/^#/) },
    });
  });

  it("is idempotent: running it again on the same entry puts nothing twice", async () => {
    await ingest({ groupId: "Work", machineId: "m1" });
    const before = await members(KEYS.events("claude", "Work"));
    const id = await trashGroup("Work");
    const meta = (await getRedis().get<string>(KEYS.trashEntry(id)))!;
    const trashed = await members(KEYS.trashEvents(id, "claude", "Work"));
    expect(await restoreTrash(tenant, id, NOW)).toMatchObject({ ok: true, merged: false });

    // As if the first run had not got to the end: the entry is still in the trash.
    await getRedis().set(KEYS.trashEntry(id), meta);
    await getRedis().zadd(KEYS.trashEvents(id, "claude", "Work"), {
      score: trashed[0]!.score,
      member: trashed[0]!.member,
    });
    await getRedis().zadd(KEYS.trash, { score: NOW.getTime(), member: id });
    expect(await restoreTrash(tenant, id, NOW)).toMatchObject({ ok: true, merged: true });

    expect(await members(KEYS.events("claude", "Work"))).toEqual(before);
    expect(await getRedis().hlen(KEYS.machines)).toBe(1);
    expect(await getRedis().exists(KEYS.trashEntry(id))).toBe(0);
    expect(await listTrash(tenant)).toEqual([]);
  });
});

describe("restoreTrash re-derives the summaries archived while the entry was away", () => {
  const redis = useRedis();

  /** Inside the previous weekly cycle [Mon 09-14, Mon 09-21). */
  const PREVIOUS = new Date("2026-09-16T10:00:00Z");
  /** Inside the cycle [Mon 09-21, Mon 09-28), which has ended by LATER. */
  const DURING = new Date("2026-09-22T10:00:00Z");
  const LATER = new Date("2026-09-30T00:00:00Z");
  const historyOf = async () => (await loadHistory(tenant, ["claude"])).claude ?? [];

  it("writes the group back into a summary archived without it, keeping the official figures and archivedAt", async () => {
    await ingest({ groupId: "Work", machineId: "w", providers: { claude: 300 } }, DURING);
    await ingest({ groupId: "Personal", machineId: "p", providers: { claude: 100 } }, DURING);
    const id = await trashGroup("Work", NOW);

    // The cycle ends while the group is in the trash: it is archived without it.
    expect(await archiveBeforeChange(tenant, LATER)).toEqual(["claude"]);
    expect((await historyOf())[0]).toMatchObject({ start: CYCLE_START_MS, total: 100, groups: { Personal: 100 } });
    // Its figure is corrected afterwards (lib/usage-store.ts saveArchivedOfficial): the re-derive keeps it.
    expect(await saveArchivedOfficial(tenant, "claude", CYCLE_START_MS, 42)).toBe(true);
    const archived = (await historyOf())[0]!;

    const { audit } = stubAudit();
    expect(await restoreTrash(tenant, id, LATER, { audit })).toMatchObject({ ok: true });

    const [summary] = await historyOf();
    expect(summary).toEqual({
      ...archived,
      total: 400,
      groups: { Work: 300, Personal: 100 },
      machines: 2,
    });
    expect(summary!.official).toBe(42);
    expect(summary!.archivedAt).toBe(archived.archivedAt);
    // The all-time ledger entry moved with it.
    expect((await loadAllTime(tenant, ["claude"])).claude).toEqual([
      expect.objectContaining({
        start: CYCLE_START_MS,
        total: 400,
        official: 42,
        groups: { Work: 300, Personal: 100 },
      }),
    ]);
    expect((await manageTrail())[0]).toMatchObject({ action: "trash_restored", rederived: 1 });
  });

  it("does not rewrite a summary of a cycle that ended before the delete: byte for byte", async () => {
    await ingest({ groupId: "Work", machineId: "w", providers: { claude: 300 } }, PREVIOUS);
    await ingest({ groupId: "Personal", machineId: "p", providers: { claude: 100 } }, PREVIOUS);
    const id = await trashGroup("Work", NOW);
    const key = KEYS.history("claude");
    const before = await getRedis().zrange(key, 0, -1);
    const ledger = await getRedis().hgetall(KEYS.allTime("claude"));
    expect(before).toHaveLength(1);

    expect(await restoreTrash(tenant, id, LATER)).toMatchObject({ ok: true });
    expect(await getRedis().zrange(key, 0, -1)).toEqual(before);
    expect(await getRedis().hgetall(KEYS.allTime("claude"))).toEqual(ledger);
  });

  it("never lowers a summary: what another trash entry holds stays in it", async () => {
    await ingest({ groupId: "Work", machineId: "w", providers: { claude: 300 } }, DURING);
    await ingest({ groupId: "Home", machineId: "h", providers: { claude: 50 } }, DURING);
    const work = await trashGroup("Work", NOW);
    // The cycle is archived with Home only; then Home is deleted too, and Work restored.
    await archiveBeforeChange(tenant, LATER);
    await trashGroup("Home", LATER);

    expect(await restoreTrash(tenant, work, LATER)).toMatchObject({ ok: true });
    expect((await historyOf())[0]).toMatchObject({ total: 350, groups: { Work: 300, Home: 50 } });
  });

  it("logs a failure and still restores", async () => {
    if (!redis.store) return;
    await ingest({ groupId: "Work", machineId: "w", providers: { claude: 300 } }, DURING);
    await ingest({ groupId: "Personal", machineId: "p", providers: { claude: 100 } }, DURING);
    const id = await trashGroup("Work", NOW);
    await archiveBeforeChange(tenant, LATER);
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);

    redis.store.failNext("ZRANGE", "ERR boom");
    const result = await restoreTrash(tenant, id, LATER, { audit: stubAudit().audit });
    expect(result).toMatchObject({ ok: true });
    expect(error).toHaveBeenCalledWith("trash.rederive_failed", expect.objectContaining({ providerId: "claude" }));
    error.mockRestore();
    // The events are back, the entry is out of the trash, the summary is as it was.
    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(1);
    expect(await getRedis().exists(KEYS.trashEntry(id))).toBe(0);
    expect((await historyOf())[0]).toMatchObject({ total: 100 });
    expect((await manageTrail())[0]).toMatchObject({ rederived: 0 });
  });

  it("logs a failure to read the indexes the same way", async () => {
    if (!redis.store) return;
    await ingest({ groupId: "Work", machineId: "w", providers: { claude: 300 } }, DURING);
    const id = await trashGroup("Work", NOW);
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    // The restore's own index read comes first; the re-derive's is the second HGETALL of the groups hash.
    let reads = 0;
    const redisClient = getRedis();
    const original = redisClient.pipeline.bind(redisClient);
    vi.spyOn(redisClient, "pipeline").mockImplementation(() => {
      const pipeline = original();
      reads += 1;
      if (reads === 3) {
        pipeline.exec = async () => {
          throw new Error("down");
        };
      }
      return pipeline;
    });
    expect(await restoreTrash(tenant, id, LATER)).toMatchObject({ ok: true });
    expect(error).toHaveBeenCalledWith("trash.rederive_failed", expect.objectContaining({ err: expect.any(Error) }));
    error.mockRestore();
    vi.restoreAllMocks();
  });

  it("leaves a summary alone whose bytes would not change", async () => {
    // Work reported in the cycle before the one archived while it was away: nothing of it belongs in that summary.
    await ingest({ groupId: "Work", machineId: "w", providers: { claude: 300 } }, PREVIOUS);
    await ingest({ groupId: "Personal", machineId: "p", providers: { claude: 100 } }, DURING);
    const id = await trashGroup("Work", NOW);
    await archiveBeforeChange(tenant, LATER);
    const before = await getRedis().zrange(KEYS.history("claude"), 0, -1);
    expect(before.length).toBeGreaterThan(0);

    expect(await restoreTrash(tenant, id, LATER, { audit: stubAudit().audit })).toMatchObject({ ok: true });
    expect(await getRedis().zrange(KEYS.history("claude"), 0, -1)).toEqual(before);
    expect((await manageTrail())[0]).toMatchObject({ rederived: 0 });
  });

  it("re-derives a summary with segments by the segments it was archived with", async () => {
    const day = 86_400_000;
    const summary: CycleSummary = {
      v: 1,
      start: CYCLE_START_MS,
      end: CYCLE_START_MS + 7 * day,
      total: 100,
      limit: null,
      official: 124,
      groups: { Personal: 100 },
      machines: 1,
      models: {},
      subLimits: {},
      archivedAt: CYCLE_START_MS + 7 * day,
      segments: [
        { start: CYCLE_START_MS, end: CYCLE_START_MS + 3 * day, official: 80, total: 0, groups: {} },
        {
          start: CYCLE_START_MS + 3 * day,
          end: CYCLE_START_MS + 7 * day,
          official: 44,
          total: 100,
          groups: { Personal: 100 },
        },
      ],
    };
    // Work reported on the second day, Personal on the fifth: before and after the keep reset the cycle was archived with.
    await ingest({ groupId: "Work", machineId: "w", providers: { claude: 300 } }, DURING);
    await ingest(
      { groupId: "Personal", machineId: "p", providers: { claude: 100 } },
      new Date(CYCLE_START_MS + 4 * day),
    );
    const id = await trashGroup("Work", NOW);
    await archiveCycle(tenant, "claude", summary);

    expect(await restoreTrash(tenant, id, LATER)).toMatchObject({ ok: true });
    expect((await historyOf())[0]).toEqual({
      ...summary,
      total: 400,
      groups: { Work: 300, Personal: 100 },
      machines: 2,
      segments: [
        { start: CYCLE_START_MS, end: CYCLE_START_MS + 3 * day, official: 80, total: 300, groups: { Work: 300 } },
        summary.segments![1],
      ],
    });
  });

  it("joins a re-created provider's own summary of a cycle, and archives nothing twice", async () => {
    await ingest({ groupId: "Work", machineId: "w", providers: { claude: 300 } }, DURING);
    const id = await trashProvider("claude", NOW);
    // The provider reports again after the delete, in the same cycle; the cycle is archived with only that.
    await ingest({ groupId: "Work", machineId: "w2", providers: { claude: 20 } }, new Date("2026-09-25T10:00:00Z"));
    await archiveBeforeChange(tenant, LATER);
    expect((await historyOf())[0]).toMatchObject({ start: CYCLE_START_MS, total: 20 });

    const { audit } = stubAudit();
    expect(await restoreTrash(tenant, id, LATER, { audit })).toMatchObject({ ok: true, merged: true });
    expect(await historyOf()).toHaveLength(1);
    expect((await historyOf())[0]).toMatchObject({
      start: CYCLE_START_MS,
      total: 320,
      groups: { Work: 320 },
      machines: 2,
    });
  });

  it("archives the cycles a restored provider missed, and rewrites the summary it had", async () => {
    // Cycle [09-14, 09-21): archived at the delete. Cycle [09-21, 09-28): ended while the provider was away, and was never archived (only the one right before the current one is).
    await ingest({ groupId: "Work", machineId: "w", providers: { claude: 300 } }, PREVIOUS);
    await ingest({ groupId: "Work", machineId: "w", providers: { claude: 500 } }, DURING);
    const id = await trashProvider("claude", NOW);
    expect((await historyOf()).map((entry) => entry.start)).toEqual([Date.parse("2026-09-14T00:00:00Z")]);

    // Current cycle is [10-05, 10-12); [09-28, 10-05) has no reports; [09-21, 09-28) has the restored ones.
    const much = new Date("2026-10-07T00:00:00Z");
    expect(await restoreTrash(tenant, id, much, { audit: stubAudit().audit })).toMatchObject({
      ok: true,
      kind: "provider",
    });

    const starts = (await historyOf()).map((entry) => entry.start);
    expect(starts).toEqual([CYCLE_START_MS, Date.parse("2026-09-14T00:00:00Z")]);
    expect((await historyOf())[0]).toMatchObject({ start: CYCLE_START_MS, total: 500, groups: { Work: 500 } });
    expect((await manageTrail())[0]).toMatchObject({ action: "trash_restored", rederived: 1 });
  });
});

describe("purgeTrash", () => {
  const redis = useRedis();

  it("removes the meta, the keys, the index entry and the registry names, and audits", async () => {
    await ingest({ groupId: "Work", machineId: "m1", providers: { claude: 1, openai: 2 } });
    const id = await trashGroup("Work");
    const { audit, calls } = stubAudit();

    expect(await purgeTrash(tenant, id, { audit })).toEqual({
      ok: true,
      affected: { events: 2, machines: 2, groups: 1 },
    });
    expect(calls).toHaveLength(1);
    expect(await getRedis().exists(KEYS.trashEntry(id))).toBe(0);
    expect(
      await getRedis().exists(KEYS.trashEvents(id, "claude", "Work"), KEYS.trashEvents(id, "openai", "Work")),
    ).toBe(0);
    expect(await getRedis().zscore(KEYS.trash, id)).toBeNull();
    expect((await registry()).filter((name) => name.includes(":trash:"))).toEqual([]);
    expect((await manageTrail())[0]).toMatchObject({
      action: "trash_purged",
      subject: { kind: "group", id: "Work" },
      trashId: id,
    });
    expect(redis.store?.keys().filter((key) => key.includes("trash")) ?? []).toEqual([]);

    // Run again, it finds nothing.
    expect(await purgeTrash(tenant, id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("works without an audit writer too", async () => {
    await ingest({ groupId: "Work", machineId: "m1" });
    const id = await trashProvider("claude");
    expect(await purgeTrash(tenant, id)).toMatchObject({ ok: true });
    expect(await listTrash(tenant)).toEqual([]);
  });
});

describe("listTrash", () => {
  useRedis();

  it("lists newest first with what was deleted, by whom and until when", async () => {
    await ingest({ groupId: "Work", machineId: "m1" });
    await ingest({ groupId: "Home", machineId: "m2" });
    const first = await trashGroup("Work", new Date(NOW.getTime() - DAY_MS));
    const second = await trashGroup("Home", NOW);

    expect(await listTrash(tenant)).toEqual([
      {
        id: second,
        kind: "group",
        name: "Home",
        deletedAt: NOW.getTime(),
        expiresAt: NOW.getTime() + 30 * DAY_MS,
        by: null,
        affected: { events: 1, machines: 1, groups: 1 },
      },
      expect.objectContaining({ id: first, name: "Work", deletedAt: NOW.getTime() - DAY_MS }),
    ]);
  });

  it("skips an id whose meta has expired or cannot be read", async () => {
    await ingest({ groupId: "Work", machineId: "m1" });
    await ingest({ groupId: "Home", machineId: "m2" });
    await ingest({ groupId: "Lab", machineId: "m3" });
    const gone = await trashGroup("Work");
    const damaged = await trashGroup("Home");
    const kept = await trashGroup("Lab");
    await getRedis().del(KEYS.trashEntry(gone));
    await getRedis().set(KEYS.trashEntry(damaged), "{}");

    expect((await listTrash(tenant)).map((entry) => entry.id)).toEqual([kept]);
  });

  it("returns at most TRASH_LIST_LIMIT entries, the newest ones", async () => {
    await ingest({ groupId: "Work", machineId: "m1" });
    const real = await trashGroup("Work");
    const fake = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ score: NOW.getTime() + index + 1, member: `fake${index}` }));
    const [first, ...rest] = fake(TRASH_LIST_LIMIT - 1);
    await getRedis().zadd(KEYS.trash, first!, ...rest);
    expect((await listTrash(tenant)).map((entry) => entry.id)).toEqual([real]);
    await getRedis().zadd(KEYS.trash, { score: NOW.getTime() + 500, member: "one-more" });
    expect(await listTrash(tenant)).toEqual([]);
  });
});

describe("trimTrash", () => {
  useRedis();

  it("drops the index ids past the retention and their registry names, and leaves fresh ones", async () => {
    await ingest({ groupId: "Work", machineId: "m1" });
    await ingest({ groupId: "Home", machineId: "m2" });
    const old = await trashGroup("Work", new Date(NOW.getTime() - 31 * DAY_MS));
    const fresh = await trashGroup("Home", NOW);

    const names = await registry();
    const dry = await trimTrash(tenant, NOW, names, true);
    expect(dry).toEqual({ removed: 1, ids: [old] });
    expect(await getRedis().zscore(KEYS.trash, old)).not.toBeNull();

    expect(await trimTrash(tenant, NOW, names, false)).toEqual({ removed: 1, ids: [old] });
    expect(await getRedis().zscore(KEYS.trash, old)).toBeNull();
    expect(await getRedis().zscore(KEYS.trash, fresh)).not.toBeNull();
    const left = await registry();
    expect(left.filter((name) => name.includes(old))).toEqual([]);
    expect(left).toEqual(expect.arrayContaining([KEYS.trashEntry(fresh), KEYS.trashEvents(fresh, "claude", "Home")]));
    // Also its keys, which a clock this far on would have expired by itself.
    expect(await getRedis().exists(KEYS.trashEntry(old), KEYS.trashEvents(old, "claude", "Work"))).toBe(0);
  });

  it("drops an index id whose names the registry no longer has", async () => {
    await getRedis().zadd(KEYS.trash, { score: NOW.getTime() - 40 * DAY_MS, member: "gone-entry-id" });
    expect(await trimTrash(tenant, NOW, [KEYS.events("claude", "Work")], false)).toEqual({
      removed: 1,
      ids: ["gone-entry-id"],
    });
    expect(await getRedis().zscore(KEYS.trash, "gone-entry-id")).toBeNull();
  });

  it("does nothing without expired entries", async () => {
    expect(await trimTrash(tenant, NOW, [], false)).toEqual({ removed: 0, ids: [] });
  });
});

describe("the trash meta", () => {
  const group: TrashMeta = {
    v: 1,
    kind: "group",
    id: "AAAAAAAAAAAAAAAA",
    name: "Work",
    at: 5,
    by: "alice",
    n: { events: 1, machines: 2, groups: 1 },
    keys: [{ p: "claude", g: "Work", n: 1 }],
    machines: { "claude:m": '{"g":"Work","ts":1,"t":2}' },
    group: '{"color":"#3987e5","ts":1}',
    excluded: ["openai"],
  };
  const provider: TrashMeta = {
    v: 1,
    kind: "provider",
    id: "BBBBBBBBBBBBBBBB",
    name: "claude",
    at: 5,
    by: null,
    n: { events: 1, machines: 0, groups: 1 },
    keys: [],
    machines: {},
    firstSeen: 7,
    official: { claude: "{}" },
    resets: null,
    hidden: false,
    excludedIn: [],
  };

  it("round-trips through its stored form, with the optional parts", async () => {
    const { serializeTrashMeta } = await import("@/lib/trash");
    expect(parseTrashMeta(serializeTrashMeta(group))).toEqual(group);
    expect(parseTrashMeta(serializeTrashMeta({ ...group, by: null, excluded: [] }))).toEqual({
      ...group,
      by: null,
      excluded: [],
    });
    const full = { ...provider, limit: 5, subLimits: [{ id: "x" }], resets: "{}", hidden: true, excludedIn: ["Work"] };
    expect(parseTrashMeta(serializeTrashMeta(full))).toEqual(full);
    expect(parseTrashMeta(serializeTrashMeta(provider))).toEqual(provider);
    // The client does not deserialize (lib/redis.ts): a document that came as an object is not read.
    expect(parseTrashMeta(JSON.parse(serializeTrashMeta(group)))).toBeNull();
  });

  it("rejects what is not a readable meta of this version", async () => {
    const { serializeTrashMeta } = await import("@/lib/trash");
    const parseStored = (value: unknown) => parseTrashMeta(JSON.stringify(value));
    const stored = (meta: TrashMeta) => JSON.parse(serializeTrashMeta(meta)) as Record<string, unknown>;
    expect(parseTrashMeta("{not json")).toBeNull();
    expect(parseTrashMeta("[]")).toBeNull();
    expect(parseTrashMeta(null)).toBeNull();
    expect(parseStored({ ...stored(group), v: 2 })).toBeNull();
    expect(parseStored({ ...stored(group), kind: "machine" })).toBeNull();
    expect(parseStored({ ...stored(group), id: 7 })).toBeNull();
    expect(parseStored({ ...stored(group), at: "now" })).toBeNull();
    expect(parseStored({ ...stored(group), name: 3 })).toBeNull();
    expect(parseStored({ ...stored(group), n: 3 })).toBeNull();
    expect(parseStored({ ...stored(group), n: { e: 1 } })).toBeNull();
    expect(parseStored({ ...stored(group), machines: "x" })).toBeNull();
    expect(parseStored({ ...stored(group), keys: [{ p: 1, g: "Work", n: 1 }] })).toBeNull();
    expect(parseStored({ ...stored(group), keys: [{ p: "claude", g: "Work", n: "x" }] })).toBeNull();
    expect(parseStored({ ...stored(group), by: 5 })?.by).toBeNull();
    expect(parseStored({ ...stored(group), keys: "x" })).toBeNull();
    expect(parseStored({ ...stored(group), keys: [{ p: "claude", g: 3, n: 1 }] })).toBeNull();
    expect(parseStored({ ...stored(group), keys: [null] })).toBeNull();
    expect(parseStored({ ...stored(group), machines: { a: 1 } })).toBeNull();
    expect(parseStored({ ...stored(group), group: 4 })).toBeNull();
    expect(parseStored({ ...stored(group), excluded: [1] })).toBeNull();
    expect(parseStored({ ...stored(provider), firstSeen: "x" })).toBeNull();
    expect(parseStored({ ...stored(provider), official: { a: 1 } })).toBeNull();
    expect(parseStored({ ...stored(provider), excludedIn: "Work" })).toBeNull();
    expect(parseStored({ ...stored(provider), official: [] })).toBeNull();
    expect(parseStored({ ...stored(provider), resets: 5 })).toBeNull();
    expect(parseStored({ ...stored(provider), hidden: "yes" })).toBeNull();
    expect(parseStored({ ...stored(provider), excludedIn: [1] })).toBeNull();
  });
});

describe("the settings parts", () => {
  const provider = (over: Partial<Extract<TrashMeta, { kind: "provider" }>> = {}): TrashMeta => ({
    v: 1,
    kind: "provider",
    id: "BBBBBBBBBBBBBBBB",
    name: "claude",
    at: 5,
    by: null,
    n: { events: 0, machines: 0, groups: 0 },
    keys: [],
    machines: {},
    firstSeen: 7,
    official: {},
    resets: null,
    hidden: false,
    excludedIn: [],
    ...over,
  });
  const group = (excluded: string[]): TrashMeta => ({
    v: 1,
    kind: "group",
    id: "AAAAAAAAAAAAAAAA",
    name: "Work",
    at: 5,
    by: null,
    n: { events: 0, machines: 0, groups: 1 },
    keys: [],
    machines: {},
    group: "{}",
    excluded,
  });
  const live = { providerLive: false, groupIds: ["Work"] };
  const doc = (value: unknown) => JSON.stringify(value);

  it("groupSettingsParts reads a group's exclusions", () => {
    expect(groupSettingsParts(null, "Work")).toEqual({});
    expect(groupSettingsParts("{nope", "Work")).toEqual({});
    expect(groupSettingsParts("[]", "Work")).toEqual({});
    expect(groupSettingsParts(doc({}), "Work")).toEqual({});
    expect(groupSettingsParts(doc({ excludedProviders: [] }), "Work")).toEqual({});
    expect(groupSettingsParts(doc({ excludedProviders: { Work: "claude" } }), "Work")).toEqual({});
    expect(groupSettingsParts(doc({ excludedProviders: { Work: ["claude", 3] } }), "Work")).toEqual({
      excluded: ["claude"],
    });
  });

  it("providerSettingsParts reads a provider's limit, sub-limits, hidden flag and exclusions", () => {
    expect(providerSettingsParts(null, "claude")).toEqual({ hidden: false, excludedIn: [] });
    expect(providerSettingsParts("[]", "claude")).toEqual({ hidden: false, excludedIn: [] });
    expect(providerSettingsParts(doc({}), "claude")).toEqual({ hidden: false, excludedIn: [] });
    expect(
      providerSettingsParts(
        doc({
          limits: { claude: 5 },
          subLimits: { claude: [1] },
          hiddenProviders: ["claude"],
          excludedProviders: { Work: ["claude"], Solo: ["openai"], Odd: "claude" },
        }),
        "claude",
      ),
    ).toEqual({ limit: 5, subLimits: [1], hidden: true, excludedIn: ["Work"] });
    expect(providerSettingsParts(doc({ limits: [], hiddenProviders: "claude" }), "claude")).toEqual({
      hidden: false,
      excludedIn: [],
    });
  });

  it("withRestoredSettings changes nothing without a readable stored document", () => {
    expect(withRestoredSettings(null, group(["openai"]), live, 1)).toBeNull();
    expect(withRestoredSettings("{nope", group(["openai"]), live, 1)).toBeNull();
    expect(withRestoredSettings("[]", provider({ limit: 5 }), live, 1)).toBeNull();
  });

  it("withRestoredSettings unions a group's exclusions", () => {
    const restored = (raw: unknown, excluded: string[]) => {
      const result = withRestoredSettings(doc(raw), group(excluded), live, 99);
      return result && JSON.parse(result);
    };
    expect(restored({ excludedProviders: { Work: ["claude"] } }, ["openai"])).toEqual({
      excludedProviders: { Work: ["claude", "openai"] },
      updatedAt: 99,
    });
    expect(restored({ v: 3 }, ["openai"])).toEqual({ v: 3, excludedProviders: { Work: ["openai"] }, updatedAt: 99 });
    expect(restored({ excludedProviders: { Work: ["openai"] } }, ["openai"])).toBeNull();
    expect(restored({ excludedProviders: { Work: ["openai"] } }, [])).toBeNull();
    expect(restored({ excludedProviders: "x" }, ["openai"])).toEqual({
      excludedProviders: { Work: ["openai"] },
      updatedAt: 99,
    });
  });

  it("withRestoredSettings puts a provider's parts back only where they are absent", () => {
    const restored = (raw: unknown, meta: TrashMeta, state = live) => {
      const result = withRestoredSettings(doc(raw), meta, state, 99);
      return result && JSON.parse(result);
    };
    const full = provider({ limit: 500, subLimits: [{ id: "f" }], hidden: true, excludedIn: ["Work", "Gone"] });

    expect(
      restored({ limits: { openai: 1 }, hiddenProviders: ["openai"], excludedProviders: { Work: ["openai"] } }, full),
    ).toEqual({
      limits: { openai: 1, claude: 500 },
      subLimits: { claude: [{ id: "f" }] },
      hiddenProviders: ["openai", "claude"],
      excludedProviders: { Work: ["openai", "claude"] },
      updatedAt: 99,
    });
    // What is there stays: a limit, sub-limits, an exclusion, a hidden entry.
    expect(
      restored(
        {
          limits: { claude: 1 },
          subLimits: { claude: [] },
          hiddenProviders: ["claude"],
          excludedProviders: { Work: ["claude"] },
        },
        full,
      ),
    ).toBeNull();
    // A provider that is live again was switched on by the user: it stays on.
    expect(restored({ hiddenProviders: [] }, full, { providerLive: true, groupIds: [] })).toMatchObject({
      limits: { claude: 500 },
      hiddenProviders: [],
    });
    // Hidden again only when it was hidden.
    expect(restored({ hiddenProviders: [] }, provider({ hidden: false }))).toBeNull();
    // Not hidden-listed document, and non-record limits.
    expect(restored({ limits: 3, hiddenProviders: "x" }, provider({ limit: 5, hidden: true }))).toEqual({
      limits: { claude: 5 },
      hiddenProviders: ["claude"],
      updatedAt: 99,
    });
  });
});
