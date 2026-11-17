import { describe, expect, it } from "vitest";
import { summarizeUsage } from "@/lib/aggregate";
import { archiveBeforeChange } from "@/lib/archive";
import { DEFAULT_RESET, INACTIVE_MACHINE_DAYS } from "@/lib/config";
import { ingestReport } from "@/lib/ingest";
import {
  deleteGroup,
  deleteMachine,
  deleteProvider,
  moveMachine,
  pruneMachines,
  renameOrMergeGroup,
} from "@/lib/manage-store";
import { officialUsageField } from "@/lib/official-usage";
import { getRedis } from "@/lib/redis";
import { loadEvents, loadHistory, loadIndexes, saveResets } from "@/lib/usage-store";
import { useRedis } from "./helpers/redis-fixture";
import { KEYS, tenant } from "./helpers/tenant";

const NOW = new Date("2026-09-23T00:00:00Z");
/** The weekly cycle NOW falls in starts on Monday; ingest stamps every stored report with it. */
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

const MOVE = {
  merge: false,
  mode: "snapshot" as const,
  reset: DEFAULT_RESET,
  retentionDays: 90,
  now: NOW,
};

describe("moveMachine — rename", () => {
  useRedis();

  it("rewrites exactly the right members and keeps scores, and moves the machine's index field", async () => {
    const t1 = Date.parse("2026-09-22T10:00:00Z");
    const t2 = Date.parse("2026-09-22T11:00:00Z");
    await ingest({
      machineId: "mac-1",
      groupId: "Personal",
      providers: { claude: 100 },
      timestamp: new Date(t1).toISOString(),
    });
    await ingest({
      machineId: "mac-2",
      groupId: "Personal",
      providers: { claude: 250 },
      timestamp: new Date(t2).toISOString(),
    });

    const result = await moveMachine(tenant, "claude", "mac-1", { machineId: "mac-1-renamed" }, MOVE);
    expect(result).toEqual({ ok: true, affected: { events: 1, machines: 1, groups: 0 } });

    const key = KEYS.events("claude", "Personal");
    const list = await members(key);
    expect(list).toHaveLength(2);
    const renamed = list.find((entry) => entry.score === t1)!;
    expect(JSON.parse(renamed.member)).toEqual({ m: "mac-1-renamed", t: 100, ts: t1, s: CYCLE_START_MS });
    const untouched = list.find((entry) => entry.score === t2)!;
    expect(JSON.parse(untouched.member)).toEqual({ m: "mac-2", t: 250, ts: t2, s: CYCLE_START_MS });

    expect(await getRedis().hexists(KEYS.machines, "claude:mac-1")).toBe(0);
    const moved = JSON.parse((await getRedis().hget<string>(KEYS.machines, "claude:mac-1-renamed"))!);
    expect(moved).toEqual({ g: "Personal", ts: t1, t: 100 });
  });

  it("keeps a manual machine's mode and an auto one's interval in its index entry", async () => {
    await ingest({ machineId: "mac-1", mode: "manual" });
    await moveMachine(tenant, "claude", "mac-1", { machineId: "mac-9" }, MOVE);
    const moved = JSON.parse((await getRedis().hget<string>(KEYS.machines, "claude:mac-9"))!);
    expect(moved.md).toBe("manual");
  });

  it("refuses (exists) onto an id already used by this provider, without changing anything", async () => {
    await ingest({ machineId: "mac-1" });
    await ingest({ machineId: "mac-2" });

    const result = await moveMachine(tenant, "claude", "mac-1", { machineId: "mac-2" }, MOVE);
    expect(result).toEqual({ ok: false, reason: "exists" });
    expect(await getRedis().hexists(KEYS.machines, "claude:mac-1")).toBe(1);
    expect(await getRedis().hexists(KEYS.machines, "claude:mac-2")).toBe(1);
  });

  it("answers not_found for a machine that does not exist", async () => {
    const result = await moveMachine(tenant, "claude", "ghost", { machineId: "new-name" }, MOVE);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("is a no-op success when neither the id nor the group changes", async () => {
    await ingest({ machineId: "mac-1" });
    const result = await moveMachine(tenant, "claude", "mac-1", { machineId: "mac-1", groupId: "Personal" }, MOVE);
    expect(result).toEqual({ ok: true, affected: { events: 0, machines: 0, groups: 0 } });
  });
});

describe("moveMachine — group", () => {
  useRedis();

  it("moves the machine's members to the new group's key and its index entry with them", async () => {
    await ingest({ machineId: "mac-1", groupId: "Personal", providers: { claude: 100 } });
    await ingest({ machineId: "mac-2", groupId: "Work", providers: { claude: 40 } });

    const result = await moveMachine(tenant, "claude", "mac-1", { groupId: "Work" }, MOVE);
    expect(result).toEqual({ ok: true, affected: { events: 1, machines: 1, groups: 1 } });

    expect(await members(KEYS.events("claude", "Personal"))).toEqual([]);
    const work = (await members(KEYS.events("claude", "Work"))).map((entry) => JSON.parse(entry.member).m);
    expect(work.sort()).toEqual(["mac-1", "mac-2"]);
    const moved = JSON.parse((await getRedis().hget<string>(KEYS.machines, "claude:mac-1"))!);
    expect(moved.g).toBe("Work");
  });

  it("answers group_not_found for a group nobody defined", async () => {
    await ingest({ machineId: "mac-1" });
    expect(await moveMachine(tenant, "claude", "mac-1", { groupId: "Nowhere" }, MOVE)).toEqual({
      ok: false,
      reason: "group_not_found",
    });
  });

  it("combines a machine's history in two groups day by day, without a merge flag", async () => {
    // The client was switched from Personal to Work: Work got the whole cycle again, minus a deleted log.
    await ingest({ machineId: "mac-1", groupId: "Personal", providers: { claude: 100 } }, new Date(DAY_1_END));
    await ingest({ machineId: "mac-1", groupId: "Work", providers: { claude: 40 } });
    await seedHistory("Work", "mac-1", [[DAY_1_END, 40]]);
    // Read as two machines today: 100 + 40.
    expect(await cycleTotal()).toBe(140);

    const result = await moveMachine(tenant, "claude", "mac-1", { groupId: "Work" }, MOVE);
    expect(result).toEqual({ ok: true, affected: { events: 1, machines: 1, groups: 1 } });
    expect(await members(KEYS.events("claude", "Personal"))).toEqual([]);
    expect(await cycleTotal()).toBe(100);
  });
});

const DAY_1_END = Date.parse("2026-09-22T00:00:00Z");
const DAY_2_END = Date.parse("2026-09-23T00:00:00Z");

/** Checkpoints straight into a group's events key, as a report's split by day leaves them. */
async function seedHistory(groupId: string, machineId: string, points: [number, number][]) {
  const [first, ...rest] = points.map(([ts, t]) => ({
    score: ts,
    member: JSON.stringify({ m: machineId, t, ts, c: 1 }),
  }));
  await getRedis().zadd(KEYS.events("claude", groupId), first!, ...rest);
}

/** The claude total of the cycle NOW falls in (weekly, from Monday), as the dashboard reads it. */
async function cycleTotal(now = NOW): Promise<number> {
  const indexes = await loadIndexes(tenant);
  const startMs = Date.parse("2026-09-21T00:00:00Z");
  const { eventsByProvider } = await loadEvents(tenant, ["claude"], indexes.groups, startMs);
  return summarizeUsage(eventsByProvider.claude!, { startMs, endMs: now.getTime() + 1 }, "snapshot").total;
}

describe("moveMachine — merge", () => {
  useRedis();
  const later = new Date("2026-09-23T12:00:00Z");

  async function seedWrongInstall() {
    // Installed as "wrong" in Personal: saw day 1 whole (100) and half of day 2 (50).
    await ingest(
      { machineId: "wrong", groupId: "Personal", providers: { claude: 150 }, timestamp: "2026-09-22T12:00:00Z" },
      new Date("2026-09-22T12:00:00Z"),
    );
    await seedHistory("Personal", "wrong", [[DAY_1_END, 100]]);
    // Uploaded again as "laptop" in Work after 60 of day 1's tokens were deleted on the machine.
    await ingest(
      { machineId: "laptop", groupId: "Work", providers: { claude: 200 }, timestamp: "2026-09-23T10:00:00Z" },
      new Date("2026-09-23T10:00:00Z"),
    );
    await seedHistory("Work", "laptop", [
      [DAY_1_END, 40],
      [DAY_2_END, 140],
    ]);
  }

  it("refuses (exists) without the merge flag", async () => {
    await seedWrongInstall();
    expect(await moveMachine(tenant, "claude", "wrong", { machineId: "laptop" }, { ...MOVE, now: later })).toEqual({
      ok: false,
      reason: "exists",
    });
  });

  it("counts each day as the identity that saw more of it, under the target's name and group", async () => {
    await seedWrongInstall();
    // Read as two machines today: 150 + 200, day 2 counted twice.
    expect(await cycleTotal(later)).toBe(350);

    const result = await moveMachine(
      tenant,
      "claude",
      "wrong",
      { machineId: "laptop" },
      { ...MOVE, merge: true, now: later },
    );
    expect(result).toEqual({ ok: true, affected: { events: 2, machines: 2, groups: 1 } });

    // Day 1: 100 (the wrong install), day 2: 100 (laptop), day 3: 60 (laptop).
    expect(await cycleTotal(later)).toBe(260);
    expect(await members(KEYS.events("claude", "Personal"))).toEqual([]);
    expect(await getRedis().hexists(KEYS.machines, "claude:wrong")).toBe(0);
    const kept = JSON.parse((await getRedis().hget<string>(KEYS.machines, "claude:laptop"))!);
    expect(kept.g).toBe("Work");

    const carried = (await members(KEYS.events("claude", "Work")))
      .map((entry) => JSON.parse(entry.member))
      .filter((m) => m.x === 1);
    expect(carried.every((member) => member.m === "laptop" && member.c === 1)).toBe(true);

    // The target reports on as before; the carry-over stays next to it.
    await ingest(
      { machineId: "laptop", groupId: "Work", providers: { claude: 230 }, timestamp: "2026-09-23T13:00:00Z" },
      new Date("2026-09-23T13:00:00Z"),
    );
    expect(await cycleTotal(new Date("2026-09-23T13:00:00Z"))).toBe(290);
  });

  it("refuses to combine histories outside snapshot mode", async () => {
    await seedWrongInstall();
    expect(
      await moveMachine(
        tenant,
        "claude",
        "wrong",
        { machineId: "laptop" },
        { ...MOVE, merge: true, mode: "delta", now: later },
      ),
    ).toEqual({ ok: false, reason: "unsupported_mode" });
  });
});

describe("deleteMachine", () => {
  useRedis();

  it("removes its hash field and its members, leaving other machines' members untouched", async () => {
    await ingest({ machineId: "mac-1", providers: { claude: 100 } });
    await ingest({ machineId: "mac-2", providers: { claude: 250 } });

    const result = await deleteMachine(tenant, "claude", "mac-1");
    expect(result).toEqual({ ok: true, affected: { events: 1, machines: 1, groups: 0 } });

    const list = await members(KEYS.events("claude", "Personal"));
    expect(list).toHaveLength(1);
    expect(JSON.parse(list[0]!.member).m).toBe("mac-2");
    expect(await getRedis().hexists(KEYS.machines, "claude:mac-1")).toBe(0);
    expect(await getRedis().hexists(KEYS.machines, "claude:mac-2")).toBe(1);
  });

  it("answers not_found for a machine that does not exist", async () => {
    expect(await deleteMachine(tenant, "claude", "ghost")).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("pruneMachines", () => {
  useRedis();

  it("removes only entries silent longer than the given threshold", async () => {
    const staleMs = NOW.getTime() - (INACTIVE_MACHINE_DAYS + 1) * 86_400_000;
    const freshMs = NOW.getTime() - 1 * 86_400_000;
    await getRedis().hset(KEYS.machines, {
      "claude:old": JSON.stringify({ g: "Personal", ts: staleMs, t: 500 }),
      "claude:recent": JSON.stringify({ g: "Personal", ts: freshMs, t: 500 }),
    });

    const result = await pruneMachines(tenant, NOW, INACTIVE_MACHINE_DAYS);
    expect(result.removedIds).toEqual(["claude:old"]);
    expect(await getRedis().hexists(KEYS.machines, "claude:old")).toBe(0);
    expect(await getRedis().hexists(KEYS.machines, "claude:recent")).toBe(1);
  });

  it("removes nothing when every machine is within the threshold", async () => {
    await getRedis().hset(KEYS.machines, {
      "claude:recent": JSON.stringify({ g: "Personal", ts: NOW.getTime(), t: 500 }),
    });
    const result = await pruneMachines(tenant, NOW, INACTIVE_MACHINE_DAYS);
    expect(result.removedIds).toEqual([]);
  });
});

describe("renameOrMergeGroup — rename", () => {
  useRedis();

  it("renames a group's events key, its own entry, its machines' g, and its settings exclusion", async () => {
    await getRedis().set(KEYS.settings, JSON.stringify({ excludedProviders: { Work: ["claude"] } }));
    const t1 = Date.parse("2026-09-22T10:00:00Z");
    await ingest({
      machineId: "mac1",
      groupId: "Work",
      providers: { claude: 100 },
      timestamp: new Date(t1).toISOString(),
    });

    const result = await renameOrMergeGroup(tenant, "Work", "Team", false, NOW);
    expect(result).toEqual({ ok: true, affected: { events: 1, machines: 1, groups: 1 } });

    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
    const list = await members(KEYS.events("claude", "Team"));
    expect(list).toEqual([{ member: JSON.stringify({ m: "mac1", t: 100, ts: t1, s: CYCLE_START_MS }), score: t1 }]);

    expect(await getRedis().hexists(KEYS.groups, "Work")).toBe(0);
    expect(await getRedis().hexists(KEYS.groups, "Team")).toBe(1);

    const machine = JSON.parse((await getRedis().hget<string>(KEYS.machines, "claude:mac1"))!);
    expect(machine.g).toBe("Team");

    const settings = JSON.parse((await getRedis().get<string>(KEYS.settings))!);
    expect(settings.excludedProviders).toEqual({ Team: ["claude"] });
  });

  it("keeps a manual machine's mode and an auto one's interval in its index entry", async () => {
    await ingest({ machineId: "mac-1", groupId: "Work", mode: "manual" });
    await ingest({ machineId: "mac-2", groupId: "Work", intervalMinutes: 30 });

    await renameOrMergeGroup(tenant, "Work", "Team", false, NOW);

    const manual = JSON.parse((await getRedis().hget<string>(KEYS.machines, "claude:mac-1"))!);
    expect(manual).toMatchObject({ g: "Team", md: "manual" });
    const auto = JSON.parse((await getRedis().hget<string>(KEYS.machines, "claude:mac-2"))!);
    expect(auto).toMatchObject({ g: "Team", iv: 30 });
    expect(auto.md).toBeUndefined();
  });

  it("refuses (exists) onto a group that already exists, without merge", async () => {
    await ingest({ groupId: "Work", providers: {} });
    await ingest({ groupId: "Team", providers: {} });

    const result = await renameOrMergeGroup(tenant, "Work", "Team", false, NOW);
    expect(result).toEqual({ ok: false, reason: "exists" });
    expect(await getRedis().hexists(KEYS.groups, "Work")).toBe(1);
  });

  it("answers not_found for a group that does not exist", async () => {
    expect(await renameOrMergeGroup(tenant, "Ghost", "Team", false, NOW)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("renameOrMergeGroup — merge", () => {
  useRedis();

  it("dedups an identical member reported into both groups, and keeps a distinct one", async () => {
    const t1 = Date.parse("2026-09-22T10:00:00Z");
    const t2 = Date.parse("2026-09-22T11:00:00Z");
    // The same machine, same tokens, same moment, reported into both groups: one identical event.
    await ingest({
      machineId: "shared",
      groupId: "Work",
      providers: { claude: 100 },
      timestamp: new Date(t1).toISOString(),
    });
    await ingest({
      machineId: "shared",
      groupId: "Team",
      providers: { claude: 100 },
      timestamp: new Date(t1).toISOString(),
    });
    // A second machine only ever reported into Work.
    await ingest({
      machineId: "solo",
      groupId: "Work",
      providers: { claude: 999 },
      timestamp: new Date(t2).toISOString(),
    });

    const result = await renameOrMergeGroup(tenant, "Work", "Team", true, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Work held 2 members before the merge (shared + solo): that is what moved.
    expect(result.affected.events).toBe(2);

    const list = await members(KEYS.events("claude", "Team"));
    // Deduped to 2, not 3: the identical "shared" event counts once.
    expect(list).toHaveLength(2);
    expect(list.map((entry) => JSON.parse(entry.member).m).sort()).toEqual(["shared", "solo"]);

    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
    expect(await getRedis().hexists(KEYS.groups, "Work")).toBe(0);
    expect(await getRedis().hexists(KEYS.groups, "Team")).toBe(1);
  });

  it("keeps a moved machine's mode and interval in its index entry", async () => {
    await ingest({ machineId: "mac-1", groupId: "Work", mode: "manual" });
    await ingest({ machineId: "mac-2", groupId: "Work", intervalMinutes: 30 });
    await ingest({ machineId: "mac-3", groupId: "Team" });

    await renameOrMergeGroup(tenant, "Work", "Team", true, NOW);

    const manual = JSON.parse((await getRedis().hget<string>(KEYS.machines, "claude:mac-1"))!);
    expect(manual).toMatchObject({ g: "Team", md: "manual" });
    const auto = JSON.parse((await getRedis().hget<string>(KEYS.machines, "claude:mac-2"))!);
    expect(auto).toMatchObject({ g: "Team", iv: 30 });
  });

  it("re-arms the destination's expiry, which the union drops", async () => {
    await ingest({ machineId: "mac-1", groupId: "Work" });
    await ingest({ machineId: "mac-2", groupId: "Team" });

    await renameOrMergeGroup(tenant, "Work", "Team", true, NOW);

    const ttl = await getRedis().ttl(KEYS.events("claude", "Team"));
    expect(ttl).toBeGreaterThan(70 * 86_400);
    expect(ttl).toBeLessThanOrEqual(71 * 86_400);
  });

  it("keeps the destination's own colour and first-seen rather than the source's", async () => {
    await ingest({ groupId: "Work", providers: {} }, new Date(NOW.getTime() - 10_000));
    await ingest({ groupId: "Team", providers: {} }, new Date(NOW.getTime() - 5_000));
    const before = JSON.parse((await getRedis().hget<string>(KEYS.groups, "Team"))!);

    await renameOrMergeGroup(tenant, "Work", "Team", true, NOW);

    const after = JSON.parse((await getRedis().hget<string>(KEYS.groups, "Team"))!);
    expect(after).toEqual(before);
  });

  it("unions the settings exclusions of both groups", async () => {
    await getRedis().set(
      KEYS.settings,
      JSON.stringify({ excludedProviders: { Work: ["claude"], Team: ["deepseek"] } }),
    );
    await ingest({ groupId: "Work", providers: {} });
    await ingest({ groupId: "Team", providers: {} });

    await renameOrMergeGroup(tenant, "Work", "Team", true, NOW);

    const settings = JSON.parse((await getRedis().get<string>(KEYS.settings))!);
    expect(new Set(settings.excludedProviders.Team)).toEqual(new Set(["claude", "deepseek"]));
    expect(settings.excludedProviders.Work).toBeUndefined();
  });
});

describe("deleteGroup", () => {
  useRedis();

  it("refuses (has_events) without force while it still has stored events", async () => {
    await ingest({ groupId: "Work" });
    const result = await deleteGroup(tenant, "Work", false, NOW);
    expect(result).toEqual({ ok: false, reason: "has_events" });
    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(1);
  });

  it("with force, deletes its events, its machines, its own entry and its settings exclusion", async () => {
    await getRedis().set(KEYS.settings, JSON.stringify({ excludedProviders: { Work: ["claude"] } }));
    await ingest({ groupId: "Work", machineId: "mac1" });

    const result = await deleteGroup(tenant, "Work", true, NOW);
    expect(result).toEqual({ ok: true, affected: { events: 1, machines: 1, groups: 1 } });

    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
    expect(await getRedis().hexists(KEYS.machines, "claude:mac1")).toBe(0);
    expect(await getRedis().hexists(KEYS.groups, "Work")).toBe(0);
    const settings = JSON.parse((await getRedis().get<string>(KEYS.settings))!);
    expect(settings.excludedProviders).toEqual({});
  });

  it("answers not_found for a group that does not exist", async () => {
    expect(await deleteGroup(tenant, "Ghost", true, NOW)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("deleteProvider", () => {
  useRedis();

  it("refuses (has_events) without force while it still has stored events", async () => {
    await ingest({});
    const result = await deleteProvider(tenant, "claude", false, NOW);
    expect(result).toEqual({ ok: false, reason: "has_events" });
  });

  it("with force, deletes its events in every group, its machines, its official usage, its resets, and scrubs the settings document", async () => {
    await getRedis().set(
      KEYS.settings,
      JSON.stringify({
        limits: { claude: 500_000, deepseek: 100 },
        subLimits: {
          claude: [{ id: "fable", name: "Fable", models: ["opus"], mode: "share", sharePercent: 10, limit: 1000 }],
        },
        hiddenProviders: ["claude"],
        excludedProviders: { Work: ["claude", "deepseek"], Solo: ["claude"] },
      }),
    );
    await getRedis().hset(KEYS.officialUsage, {
      [officialUsageField("claude", null)]: JSON.stringify({ raw: "10", enteredAt: 0, cycleStartMs: 0 }),
      [officialUsageField("claude", "fable")]: JSON.stringify({ raw: "5", enteredAt: 0, cycleStartMs: 0 }),
    });
    await ingest({ groupId: "Work", machineId: "mac1", providers: { claude: 100 } });
    await ingest({ groupId: "Solo", machineId: "mac2", providers: { claude: 200 } });
    await saveResets(tenant, "claude", {
      v: 1,
      events: [
        {
          id: "r",
          atMs: CYCLE_START_MS + 3_600_000,
          kind: "keep",
          cycleStartMs: CYCLE_START_MS,
          before: 50,
          beforeAtMs: null,
          source: "manual",
          recordedAtMs: CYCLE_START_MS + 3_600_000,
        },
      ],
      autoOffCycleStartMs: null,
    });
    await saveResets(tenant, "openai", { v: 1, events: [], autoOffCycleStartMs: CYCLE_START_MS });

    const result = await deleteProvider(tenant, "claude", true, NOW);
    expect(result).toEqual({ ok: true, affected: { events: 2, machines: 2, groups: 2 } });

    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
    expect(await getRedis().exists(KEYS.events("claude", "Solo"))).toBe(0);
    expect(await getRedis().hexists(KEYS.providers, "claude")).toBe(0);
    expect(await getRedis().hexists(KEYS.machines, "claude:mac1")).toBe(0);
    expect(await getRedis().hexists(KEYS.machines, "claude:mac2")).toBe(0);
    expect(await getRedis().hexists(KEYS.officialUsage, officialUsageField("claude", null))).toBe(0);
    expect(await getRedis().hexists(KEYS.officialUsage, officialUsageField("claude", "fable"))).toBe(0);
    expect(await getRedis().hexists(KEYS.resets, "claude")).toBe(0);
    expect(await getRedis().hexists(KEYS.resets, "openai")).toBe(1);

    const settings = JSON.parse((await getRedis().get<string>(KEYS.settings))!);
    expect(settings.limits).toEqual({ deepseek: 100 });
    expect(settings.subLimits).toEqual({});
    expect(settings.hiddenProviders).toEqual([]);
    expect(settings.excludedProviders).toEqual({ Work: ["deepseek"] });
  });

  it("answers not_found for a provider that does not exist", async () => {
    expect(await deleteProvider(tenant, "ghost", true, NOW)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("archiving before a destructive change", () => {
  const useRedisHandle = useRedis();

  /** Inside the previous weekly cycle, [Mon 09-14, Mon 09-21), which has ended at NOW and is not archived yet. */
  const PREVIOUS = new Date("2026-09-16T10:00:00Z");
  const previous = (body: Record<string, unknown>) => ingest({ timestamp: PREVIOUS.toISOString(), ...body }, PREVIOUS);
  const historyOf = async (providerId = "claude") => (await loadHistory(tenant, [providerId]))[providerId] ?? [];

  it("keeps the deleted group in the summary of the cycle that just ended (deleteGroup)", async () => {
    await previous({ groupId: "Work", machineId: "w", providers: { claude: 300 } });
    await previous({ groupId: "Personal", machineId: "p", providers: { claude: 100 } });
    expect(await historyOf()).toEqual([]);

    const result = await deleteGroup(tenant, "Work", true, NOW);
    expect(result.ok).toBe(true);

    const [summary] = await historyOf();
    expect(summary?.start).toBe(Date.parse("2026-09-14T00:00:00Z"));
    expect(Object.keys(summary!.groups).sort()).toEqual(["Personal", "Work"]);
    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
  });

  it("archives only the providers the deleted group has events for", async () => {
    await previous({ groupId: "Work", machineId: "w", providers: { claude: 300 } });
    await previous({ groupId: "Personal", machineId: "p", providers: { openai: 100 } });

    await deleteGroup(tenant, "Work", true, NOW);

    expect(await historyOf("claude")).toHaveLength(1);
    expect(await historyOf("openai")).toEqual([]);
  });

  it("keeps the deleted provider's groups in its own summary (deleteProvider)", async () => {
    await previous({ groupId: "Work", machineId: "w", providers: { claude: 300, openai: 50 } });
    await previous({ groupId: "Personal", machineId: "p", providers: { claude: 100 } });

    const result = await deleteProvider(tenant, "claude", true, NOW);
    expect(result.ok).toBe(true);

    const [summary] = await historyOf();
    expect(Object.keys(summary!.groups).sort()).toEqual(["Personal", "Work"]);
    // Only the deleted provider is archived; the other waits for the housekeeping run as usual.
    expect(await historyOf("openai")).toEqual([]);
    expect(await getRedis().hexists(KEYS.providers, "claude")).toBe(0);
  });

  it("keeps both groups' split in the summary of a merge", async () => {
    await previous({ groupId: "Work", machineId: "w", providers: { claude: 300 } });
    await previous({ groupId: "Team", machineId: "t", providers: { claude: 100 } });

    const result = await renameOrMergeGroup(tenant, "Work", "Team", true, NOW);
    expect(result.ok).toBe(true);

    const [summary] = await historyOf();
    expect(Object.keys(summary!.groups).sort()).toEqual(["Team", "Work"]);
    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
  });

  it("writes no history for a refused delete, a plain rename, or a delete with nothing stored", async () => {
    await previous({ groupId: "Work", machineId: "w", providers: { claude: 300 } });
    await ingest({ groupId: "Empty", providers: {} });
    await ingest({ groupId: "Quiet", providers: {} });

    expect(await deleteGroup(tenant, "Work", false, NOW)).toEqual({ ok: false, reason: "has_events" });
    expect(await deleteProvider(tenant, "claude", false, NOW)).toEqual({ ok: false, reason: "has_events" });
    expect((await renameOrMergeGroup(tenant, "Work", "Renamed", false, NOW)).ok).toBe(true);
    // A forced delete and a merge of groups that hold no events have nothing to archive either.
    expect((await deleteGroup(tenant, "Empty", true, NOW)).ok).toBe(true);
    expect((await renameOrMergeGroup(tenant, "Quiet", "Renamed", true, NOW)).ok).toBe(true);

    expect(await historyOf()).toEqual([]);
  });

  it("goes ahead with the delete when writing the summary fails, but not when the read fails", async () => {
    const redis = useRedisHandle;
    if (!redis.store) return; // the failure is injected into the in-memory store
    await previous({ groupId: "Work", machineId: "w", providers: { claude: 300 } });

    // Writing the summary fails: logged per provider, the delete still happens.
    redis.store.failNext("ZADD");
    expect((await deleteGroup(tenant, "Work", true, NOW)).ok).toBe(true);
    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
    expect(await historyOf()).toEqual([]);

    // Reading the indexes fails: the error reaches the caller, and nothing is deleted.
    await previous({ groupId: "Personal", machineId: "p", providers: { claude: 100 } });
    redis.store.failNext("HGETALL");
    await expect(deleteGroup(tenant, "Personal", true, NOW)).rejects.toThrow();
    expect(await getRedis().exists(KEYS.events("claude", "Personal"))).toBe(1);
  });

  it("archiveBeforeChange archives every provider by default, or only the ones named", async () => {
    await previous({ groupId: "Work", machineId: "w", providers: { claude: 300, openai: 50 } });

    expect(await archiveBeforeChange(tenant, NOW, { providerIds: ["ghost"] })).toEqual([]);
    expect(await archiveBeforeChange(tenant, NOW, { providerIds: ["openai"] })).toEqual(["openai"]);
    expect(await archiveBeforeChange(tenant, NOW, { indexes: await loadIndexes(tenant) })).toEqual(["claude"]);
    // Already archived: nothing is due any more.
    expect(await archiveBeforeChange(tenant, NOW)).toEqual([]);
  });

  it("archiveBeforeChange on a store with no providers returns [] without reading events", async () => {
    expect(await archiveBeforeChange(tenant, NOW)).toEqual([]);
  });
});
