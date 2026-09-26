import { describe, expect, it } from "vitest";
import { migrateLegacyData, planLegacyMigration } from "@/lib/migrate-legacy";
import { getRedis, toStringRecord } from "@/lib/redis";
import { useRedis } from "./helpers/redis-fixture";

/**
 * Hand-seeds the pre-provider key layout lib/usage-store.ts no longer reads
 * (see its top-of-file comment), then drives lib/migrate-legacy.ts against it.
 *
 *   usage:groups: "Work" (legacy events only), "Personal" (legacy AND a real
 *   "deepseek" report already exist — the overlapping case), "Untouched" (no
 *   legacy data at all).
 *
 *   usage:machines: "mac-studio" and "win-1" unprefixed (legacy), "win-1" also
 *   has a newer "deepseek:win-1" already (the overlapping case), and
 *   "claude:mac-studio" is already provider-prefixed (nothing to do).
 */
async function seedLegacyStore(): Promise<void> {
  const redis = getRedis();
  await redis.hset("usage:groups", {
    Work: JSON.stringify({ color: "#3987e5", ts: 100 }),
    Personal: JSON.stringify({ color: "#d95926", ts: 200 }),
    Untouched: JSON.stringify({ color: "#199e70", ts: 300 }),
  });

  await redis.zadd("usage:events:Work", { score: 100, member: "w1" }, { score: 200, member: "w2" });

  // Personal has both the legacy set and a real "deepseek" one already: they must merge, not just rename.
  await redis.zadd("usage:events:Personal", { score: 50, member: "shared" }, { score: 80, member: "legacy-only" });
  await redis.zadd(
    "usage:events:deepseek:Personal",
    { score: 999, member: "shared" },
    { score: 10, member: "new-only" },
  );

  await redis.hset("usage:machines", {
    "mac-studio": JSON.stringify({ g: "Work", ts: 1000, t: 500 }),
    "win-1": JSON.stringify({ g: "Work", ts: 2000, t: 10 }),
    "deepseek:win-1": JSON.stringify({ g: "Work", ts: 3000, t: 99 }),
    "claude:mac-studio": JSON.stringify({ g: "Work", ts: 1500, t: 20 }),
  });
}

describe("planLegacyMigration", () => {
  useRedis();

  it("reads the plan without writing anything", async () => {
    await seedLegacyStore();
    const plan = await planLegacyMigration();
    expect(plan.events.sort((a, b) => a.groupId.localeCompare(b.groupId))).toEqual([
      { groupId: "Personal", action: "merge" },
      { groupId: "Untouched", action: "skip" },
      { groupId: "Work", action: "rename" },
    ]);
    expect(plan.machines.sort((a, b) => a.field.localeCompare(b.field))).toEqual([
      { field: "claude:mac-studio", action: "skip" },
      { field: "deepseek:win-1", action: "skip" },
      { field: "mac-studio", action: "move" },
      { field: "win-1", action: "move" },
    ]);
  });
});

describe("migrateLegacyData", () => {
  useRedis();

  it("plans but writes nothing on a dry run", async () => {
    await seedLegacyStore();
    const before = getRedis();
    const { summary } = await migrateLegacyData({ apply: false });
    expect(summary).toEqual({ renamed: 1, merged: 1, machinesMoved: 2, skipped: 3 });

    // Nothing moved: the legacy keys and fields are all still exactly there.
    expect(await before.exists("usage:events:Work")).toBe(1);
    expect(await before.exists("usage:events:Personal")).toBe(1);
    const machines = toStringRecord(await before.hgetall("usage:machines"));
    expect(Object.keys(machines).sort()).toEqual(["claude:mac-studio", "deepseek:win-1", "mac-studio", "win-1"]);
  });

  it("renames a group with no prior provider data, merges one that overlaps", async () => {
    await seedLegacyStore();
    const { summary } = await migrateLegacyData({ apply: true });
    expect(summary).toEqual({ renamed: 1, merged: 1, machinesMoved: 2, skipped: 3 });

    const redis = getRedis();
    // Work: a plain rename, members carried over untouched.
    expect(await redis.exists("usage:events:Work")).toBe(0);
    expect(await redis.zrange("usage:events:deepseek:Work", 0, -1, { withScores: true })).toEqual([
      "w1",
      "100",
      "w2",
      "200",
    ]);

    // Personal: unioned with AGGREGATE MAX, then the legacy set is gone.
    expect(await redis.exists("usage:events:Personal")).toBe(0);
    const personal = await redis.zrange<string[]>("usage:events:deepseek:Personal", 0, -1, { withScores: true });
    const byMember = new Map<string, string>();
    for (let i = 0; i < personal.length; i += 2) byMember.set(personal[i]!, personal[i + 1]!);
    expect(byMember.get("shared")).toBe("999"); // the higher of the two scores wins
    expect(byMember.get("legacy-only")).toBe("80");
    expect(byMember.get("new-only")).toBe("10");

    // Machines: the unprefixed fields are gone, folded under "deepseek:".
    const machines = toStringRecord(await redis.hgetall("usage:machines"));
    expect(Object.keys(machines).sort()).toEqual(["claude:mac-studio", "deepseek:mac-studio", "deepseek:win-1"]);
    expect(JSON.parse(machines["deepseek:mac-studio"]!)).toEqual({ g: "Work", ts: 1000, t: 500 });
    // win-1 already had a newer "deepseek:" row: that one wins, the legacy one is dropped.
    expect(JSON.parse(machines["deepseek:win-1"]!)).toEqual({ g: "Work", ts: 3000, t: 99 });
    expect(JSON.parse(machines["claude:mac-studio"]!)).toEqual({ g: "Work", ts: 1500, t: 20 });
  });

  it("is idempotent: a second run finds nothing left to do", async () => {
    await seedLegacyStore();
    await migrateLegacyData({ apply: true });
    const redis = getRedis();
    const before = (await redis.hgetall("usage:machines")) as unknown;
    const workBefore = await redis.zrange("usage:events:deepseek:Work", 0, -1, { withScores: true });
    const personalBefore = await redis.zrange("usage:events:deepseek:Personal", 0, -1, { withScores: true });

    const { plan, summary } = await migrateLegacyData({ apply: true });
    expect(plan.events.every((event) => event.action === "skip")).toBe(true);
    expect(plan.machines.every((machine) => machine.action === "skip")).toBe(true);
    expect(summary).toEqual({
      renamed: 0,
      merged: 0,
      machinesMoved: 0,
      skipped: plan.events.length + plan.machines.length,
    });

    expect(await redis.hgetall("usage:machines")).toEqual(before);
    expect(await redis.zrange("usage:events:deepseek:Work", 0, -1, { withScores: true })).toEqual(workBefore);
    expect(await redis.zrange("usage:events:deepseek:Personal", 0, -1, { withScores: true })).toEqual(personalBefore);

    // Same for a dry run against an already-migrated store.
    const dry = await migrateLegacyData({ apply: false });
    expect(dry.summary).toEqual({
      renamed: 0,
      merged: 0,
      machinesMoved: 0,
      skipped: dry.plan.events.length + dry.plan.machines.length,
    });
  });

  it("does nothing to a store with no legacy data at all", async () => {
    const redis = getRedis();
    await redis.hset("usage:groups", { Fresh: JSON.stringify({ color: "#3987e5", ts: 1 }) });
    await redis.zadd("usage:events:deepseek:Fresh", { score: 1, member: "a" });
    await redis.hset("usage:machines", { "deepseek:mac": JSON.stringify({ g: "Fresh", ts: 1, t: 1 }) });

    const { summary } = await migrateLegacyData({ apply: true });
    expect(summary).toEqual({ renamed: 0, merged: 0, machinesMoved: 0, skipped: 2 });
    expect(await redis.exists("usage:events:deepseek:Fresh")).toBe(1);
  });
});
