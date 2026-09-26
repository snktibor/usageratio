import { describe, expect, it } from "vitest";
import { INACTIVE_MACHINE_DAYS } from "@/lib/config";
import { ingestReport } from "@/lib/ingest";
import {
  deleteGroup,
  deleteMachine,
  deleteProvider,
  pruneMachines,
  renameMachine,
  renameOrMergeGroup,
} from "@/lib/manage-store";
import { officialUsageField } from "@/lib/official-usage";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { useRedis } from "./helpers/redis-fixture";

const NOW = new Date("2026-09-23T00:00:00Z");

async function ingest(body: Record<string, unknown>, now = NOW) {
  const result = await ingestReport(
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

describe("renameMachine", () => {
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

    const result = await renameMachine("claude", "mac-1", "mac-1-renamed");
    expect(result).toEqual({ ok: true, affected: { events: 1, machines: 1, groups: 0 } });

    const key = KEYS.events("claude", "Personal");
    const list = await members(key);
    expect(list).toHaveLength(2);
    const renamed = list.find((entry) => entry.score === t1)!;
    expect(JSON.parse(renamed.member)).toEqual({ m: "mac-1-renamed", t: 100, ts: t1 });
    const untouched = list.find((entry) => entry.score === t2)!;
    expect(JSON.parse(untouched.member)).toEqual({ m: "mac-2", t: 250, ts: t2 });

    expect(await getRedis().hexists(KEYS.machines, "claude:mac-1")).toBe(0);
    const moved = JSON.parse((await getRedis().hget<string>(KEYS.machines, "claude:mac-1-renamed"))!);
    expect(moved).toEqual({ g: "Personal", ts: t1, t: 100 });
  });

  it("refuses (exists) onto an id already used by this provider, without changing anything", async () => {
    await ingest({ machineId: "mac-1" });
    await ingest({ machineId: "mac-2" });

    const result = await renameMachine("claude", "mac-1", "mac-2");
    expect(result).toEqual({ ok: false, reason: "exists" });
    expect(await getRedis().hexists(KEYS.machines, "claude:mac-1")).toBe(1);
    expect(await getRedis().hexists(KEYS.machines, "claude:mac-2")).toBe(1);
  });

  it("answers not_found for a machine that does not exist", async () => {
    const result = await renameMachine("claude", "ghost", "new-name");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("is a no-op success when the new id is the same as the old one", async () => {
    await ingest({ machineId: "mac-1" });
    const result = await renameMachine("claude", "mac-1", "mac-1");
    expect(result).toEqual({ ok: true, affected: { events: 0, machines: 0, groups: 0 } });
  });
});

describe("deleteMachine", () => {
  useRedis();

  it("removes its hash field and its members, leaving other machines' members untouched", async () => {
    await ingest({ machineId: "mac-1", providers: { claude: 100 } });
    await ingest({ machineId: "mac-2", providers: { claude: 250 } });

    const result = await deleteMachine("claude", "mac-1");
    expect(result).toEqual({ ok: true, affected: { events: 1, machines: 1, groups: 0 } });

    const list = await members(KEYS.events("claude", "Personal"));
    expect(list).toHaveLength(1);
    expect(JSON.parse(list[0]!.member).m).toBe("mac-2");
    expect(await getRedis().hexists(KEYS.machines, "claude:mac-1")).toBe(0);
    expect(await getRedis().hexists(KEYS.machines, "claude:mac-2")).toBe(1);
  });

  it("answers not_found for a machine that does not exist", async () => {
    expect(await deleteMachine("claude", "ghost")).toEqual({ ok: false, reason: "not_found" });
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

    const result = await pruneMachines(NOW, INACTIVE_MACHINE_DAYS);
    expect(result.removedIds).toEqual(["claude:old"]);
    expect(await getRedis().hexists(KEYS.machines, "claude:old")).toBe(0);
    expect(await getRedis().hexists(KEYS.machines, "claude:recent")).toBe(1);
  });

  it("removes nothing when every machine is within the threshold", async () => {
    await getRedis().hset(KEYS.machines, {
      "claude:recent": JSON.stringify({ g: "Personal", ts: NOW.getTime(), t: 500 }),
    });
    const result = await pruneMachines(NOW, INACTIVE_MACHINE_DAYS);
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

    const result = await renameOrMergeGroup("Work", "Team", false, NOW);
    expect(result).toEqual({ ok: true, affected: { events: 1, machines: 1, groups: 1 } });

    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
    const list = await members(KEYS.events("claude", "Team"));
    expect(list).toEqual([{ member: JSON.stringify({ m: "mac1", t: 100, ts: t1 }), score: t1 }]);

    expect(await getRedis().hexists(KEYS.groups, "Work")).toBe(0);
    expect(await getRedis().hexists(KEYS.groups, "Team")).toBe(1);

    const machine = JSON.parse((await getRedis().hget<string>(KEYS.machines, "claude:mac1"))!);
    expect(machine.g).toBe("Team");

    const settings = JSON.parse((await getRedis().get<string>(KEYS.settings))!);
    expect(settings.excludedProviders).toEqual({ Team: ["claude"] });
  });

  it("refuses (exists) onto a group that already exists, without merge", async () => {
    await ingest({ groupId: "Work", providers: {} });
    await ingest({ groupId: "Team", providers: {} });

    const result = await renameOrMergeGroup("Work", "Team", false, NOW);
    expect(result).toEqual({ ok: false, reason: "exists" });
    expect(await getRedis().hexists(KEYS.groups, "Work")).toBe(1);
  });

  it("answers not_found for a group that does not exist", async () => {
    expect(await renameOrMergeGroup("Ghost", "Team", false, NOW)).toEqual({ ok: false, reason: "not_found" });
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

    const result = await renameOrMergeGroup("Work", "Team", true, NOW);
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

  it("keeps the destination's own colour and first-seen rather than the source's", async () => {
    await ingest({ groupId: "Work", providers: {} }, new Date(NOW.getTime() - 10_000));
    await ingest({ groupId: "Team", providers: {} }, new Date(NOW.getTime() - 5_000));
    const before = JSON.parse((await getRedis().hget<string>(KEYS.groups, "Team"))!);

    await renameOrMergeGroup("Work", "Team", true, NOW);

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

    await renameOrMergeGroup("Work", "Team", true, NOW);

    const settings = JSON.parse((await getRedis().get<string>(KEYS.settings))!);
    expect(new Set(settings.excludedProviders.Team)).toEqual(new Set(["claude", "deepseek"]));
    expect(settings.excludedProviders.Work).toBeUndefined();
  });
});

describe("deleteGroup", () => {
  useRedis();

  it("refuses (has_events) without force while it still has stored events", async () => {
    await ingest({ groupId: "Work" });
    const result = await deleteGroup("Work", false, NOW);
    expect(result).toEqual({ ok: false, reason: "has_events" });
    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(1);
  });

  it("with force, deletes its events, its machines, its own entry and its settings exclusion", async () => {
    await getRedis().set(KEYS.settings, JSON.stringify({ excludedProviders: { Work: ["claude"] } }));
    await ingest({ groupId: "Work", machineId: "mac1" });

    const result = await deleteGroup("Work", true, NOW);
    expect(result).toEqual({ ok: true, affected: { events: 1, machines: 1, groups: 1 } });

    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
    expect(await getRedis().hexists(KEYS.machines, "claude:mac1")).toBe(0);
    expect(await getRedis().hexists(KEYS.groups, "Work")).toBe(0);
    const settings = JSON.parse((await getRedis().get<string>(KEYS.settings))!);
    expect(settings.excludedProviders).toEqual({});
  });

  it("answers not_found for a group that does not exist", async () => {
    expect(await deleteGroup("Ghost", true, NOW)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("deleteProvider", () => {
  useRedis();

  it("refuses (has_events) without force while it still has stored events", async () => {
    await ingest({});
    const result = await deleteProvider("claude", false, NOW);
    expect(result).toEqual({ ok: false, reason: "has_events" });
  });

  it("with force, deletes its events in every group, its machines, its official usage, and scrubs the settings document", async () => {
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

    const result = await deleteProvider("claude", true, NOW);
    expect(result).toEqual({ ok: true, affected: { events: 2, machines: 2, groups: 2 } });

    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
    expect(await getRedis().exists(KEYS.events("claude", "Solo"))).toBe(0);
    expect(await getRedis().hexists(KEYS.providers, "claude")).toBe(0);
    expect(await getRedis().hexists(KEYS.machines, "claude:mac1")).toBe(0);
    expect(await getRedis().hexists(KEYS.machines, "claude:mac2")).toBe(0);
    expect(await getRedis().hexists(KEYS.officialUsage, officialUsageField("claude", null))).toBe(0);
    expect(await getRedis().hexists(KEYS.officialUsage, officialUsageField("claude", "fable"))).toBe(0);

    const settings = JSON.parse((await getRedis().get<string>(KEYS.settings))!);
    expect(settings.limits).toEqual({ deepseek: 100 });
    expect(settings.subLimits).toEqual({});
    expect(settings.hiddenProviders).toEqual([]);
    expect(settings.excludedProviders).toEqual({ Work: ["deepseek"] });
  });

  it("answers not_found for a provider that does not exist", async () => {
    expect(await deleteProvider("ghost", true, NOW)).toEqual({ ok: false, reason: "not_found" });
  });
});
