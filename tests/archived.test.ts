import { describe, expect, it } from "vitest";
import { archivedGroupIds, isMachineArchived } from "@/lib/archived";
import { DEFAULT_RESET, getConfig, INACTIVE_MACHINE_DAYS } from "@/lib/config";
import { runHousekeeping } from "@/lib/housekeeping";
import { ingestReport } from "@/lib/ingest";
import { machineRows, splitArchivedRows } from "@/lib/machine-rows";
import {
  moveMachine,
  pruneMachines,
  renameOrMergeGroup,
  setGroupArchived,
  setMachineArchived,
} from "@/lib/manage-store";
import { getRedis } from "@/lib/redis";
import {
  buildSettingsView,
  parseGroupEntry,
  resolveGroupColors,
  serializeGroupEntry,
  settingsFromConfig,
} from "@/lib/settings";
import { loadIndexes, saveSettings } from "@/lib/usage-store";
import { useRedis } from "./helpers/redis-fixture";
import { KEYS, tenant } from "./helpers/tenant";

const NOW = new Date("2026-09-23T00:00:00Z");
const DAY_MS = 86_400_000;

async function ingest(body: Record<string, unknown>, now = NOW) {
  const result = await ingestReport(
    tenant,
    { machineId: "mac", groupId: "Personal", providers: { claude: 100 }, timestamp: now.toISOString(), ...body },
    now,
  );
  if (!result.ok) throw new Error("errors" in result ? result.errors.join("; ") : JSON.stringify(result));
  return result;
}

async function groupOf(groupId: string) {
  return (await loadIndexes(tenant)).groups.find((group) => group.groupId === groupId);
}

async function machineOf(providerId: string, machineId: string) {
  return (await loadIndexes(tenant)).machines.find(
    (machine) => machine.providerId === providerId && machine.machineId === machineId,
  );
}

describe("the archive rule", () => {
  it("names the archived groups", () => {
    expect([...archivedGroupIds([{ groupId: "Old", archivedAt: 1 }, { groupId: "Work" }])]).toEqual(["Old"]);
  });

  it("counts a machine archived by its own mark or its group's", () => {
    const archived = new Set(["Old"]);
    expect(isMachineArchived({ groupId: "Work", archivedAt: 1 }, archived)).toBe(true);
    expect(isMachineArchived({ groupId: "Old" }, archived)).toBe(true);
    expect(isMachineArchived({ groupId: "Work" }, archived)).toBe(false);
  });

  it("archives a row only once every entry of it is", () => {
    const entry = { lastSeenAt: 0, lastTokens: 0 };
    const rows = machineRows([
      { ...entry, providerId: "claude", machineId: "gone", groupId: "Work", archivedAt: 1 },
      { ...entry, providerId: "codex", machineId: "gone", groupId: "Old" },
      { ...entry, providerId: "claude", machineId: "half", groupId: "Work", archivedAt: 1 },
      { ...entry, providerId: "codex", machineId: "half", groupId: "Work" },
    ]);
    const { active, archived } = splitArchivedRows(rows, new Set(["Old"]));
    expect(active.map((row) => row.machineId)).toEqual(["half"]);
    expect(archived.map((row) => row.machineId)).toEqual(["gone"]);
  });
});

describe("the stored mark", () => {
  it("round-trips in a group entry, and is left out while active", () => {
    expect(serializeGroupEntry("#3987e5", 5)).toBe('{"color":"#3987e5","ts":5}');
    const raw = serializeGroupEntry("#3987e5", 5, 9);
    expect(parseGroupEntry("Old", raw)).toEqual({ groupId: "Old", color: "#3987e5", firstSeenAt: 5, archivedAt: 9 });
    expect(parseGroupEntry("Old", '{"color":"#3987e5","ts":5,"ar":"x"}')).not.toHaveProperty("archivedAt");
  });

  it("reaches the settings view only on an archived group", () => {
    const view = buildSettingsView(
      getConfig(),
      [
        { groupId: "Old", color: "#3987e5", firstSeenAt: 1, archivedAt: 9, hasReports: true },
        { groupId: "Work", color: "#e5a039", firstSeenAt: 2, hasReports: true },
      ],
      { multiTenant: false },
    );
    expect(view.groups).toEqual([
      { id: "Old", color: "#3987e5", hasReports: true, archivedAt: 9 },
      { id: "Work", color: "#e5a039", hasReports: true },
    ]);
  });
});

describe("setGroupArchived", () => {
  useRedis();

  it("marks the group and keeps its reports, colour and first-seen time; a restore clears the mark", async () => {
    await ingest({});
    const before = await groupOf("Personal");

    expect(await setGroupArchived(tenant, "Personal", true, NOW)).toEqual({ ok: true, changed: true });
    expect(await groupOf("Personal")).toEqual({ ...before, archivedAt: NOW.getTime() });
    expect(await getRedis().exists(KEYS.events("claude", "Personal"))).toBe(1);

    expect(await setGroupArchived(tenant, "Personal", true, NOW)).toEqual({ ok: true, changed: false });
    expect(await setGroupArchived(tenant, "Personal", false, NOW)).toEqual({ ok: true, changed: true });
    expect(await groupOf("Personal")).toEqual(before);
    expect(await setGroupArchived(tenant, "Personal", false, NOW)).toEqual({ ok: true, changed: false });
  });

  it("gives an entry older than colours the colour the dashboard shows it in", async () => {
    await getRedis().hset(KEYS.groups, { Legacy: "1000" });
    const shown = resolveGroupColors((await loadIndexes(tenant)).groups).get("Legacy");

    await setGroupArchived(tenant, "Legacy", true, NOW);
    expect(await groupOf("Legacy")).toEqual({
      groupId: "Legacy",
      color: shown,
      firstSeenAt: 1000,
      archivedAt: NOW.getTime(),
    });
  });

  it("refuses an unknown group", async () => {
    expect(await setGroupArchived(tenant, "Nobody", true, NOW)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("setMachineArchived", () => {
  useRedis();

  it("marks one provider's entry and keeps everything else in it; a restore clears the mark", async () => {
    await ingest({ providers: { claude: 100, codex: 50 } });
    const before = await machineOf("claude", "mac");

    expect(await setMachineArchived(tenant, "claude", "mac", true, NOW)).toEqual({ ok: true, changed: true });
    expect(await machineOf("claude", "mac")).toEqual({ ...before, archivedAt: NOW.getTime() });
    expect(await machineOf("codex", "mac")).not.toHaveProperty("archivedAt");

    expect(await setMachineArchived(tenant, "claude", "mac", true, NOW)).toEqual({ ok: true, changed: false });
    expect(await setMachineArchived(tenant, "claude", "mac", false, NOW)).toEqual({ ok: true, changed: true });
    expect(await machineOf("claude", "mac")).toEqual(before);
  });

  it("refuses an unknown machine", async () => {
    expect(await setMachineArchived(tenant, "claude", "nobody", true, NOW)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("a report from something archived", () => {
  useRedis();

  it("brings back its group and its machine", async () => {
    await ingest({});
    await setGroupArchived(tenant, "Personal", true, NOW);
    await setMachineArchived(tenant, "claude", "mac", true, NOW);
    const color = (await groupOf("Personal"))?.color;

    await ingest({ providers: { claude: 200 } }, new Date(NOW.getTime() + 3_600_000));
    expect(await groupOf("Personal")).toMatchObject({ color });
    expect(await groupOf("Personal")).not.toHaveProperty("archivedAt");
    expect(await machineOf("claude", "mac")).not.toHaveProperty("archivedAt");
  });

  it("brings back the group on a heartbeat too", async () => {
    await ingest({});
    await setGroupArchived(tenant, "Personal", true, NOW);
    await ingest({ providers: {} }, new Date(NOW.getTime() + 3_600_000));
    expect(await groupOf("Personal")).not.toHaveProperty("archivedAt");
  });

  it("gives a hand-edited archived entry without a colour one", async () => {
    await getRedis().hset(KEYS.groups, { Personal: JSON.stringify({ ts: 1, ar: 2 }) });
    await ingest({});
    expect((await groupOf("Personal"))?.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(await groupOf("Personal")).not.toHaveProperty("archivedAt");
  });

  it("leaves an active group's entry alone", async () => {
    await ingest({});
    const raw = await getRedis().hget(KEYS.groups, "Personal");
    await ingest({ providers: { claude: 200 } }, new Date(NOW.getTime() + 3_600_000));
    expect(await getRedis().hget(KEYS.groups, "Personal")).toEqual(raw);
  });
});

describe("what keeps the mark", () => {
  useRedis();

  it("a save of the settings panel", async () => {
    await ingest({});
    await setGroupArchived(tenant, "Personal", true, NOW);
    const settings = settingsFromConfig(getConfig(), ["claude"]);
    const saved = await saveSettings(
      tenant,
      { settings, groups: [{ id: "Personal", color: "#123456" }], removedGroups: [] },
      NOW,
      ["claude"],
    );
    expect(saved).toEqual({ ok: true });
    expect(await groupOf("Personal")).toMatchObject({ color: "#123456", archivedAt: NOW.getTime() });
  });

  it("a group rename, for the group and its machines", async () => {
    await ingest({});
    await setGroupArchived(tenant, "Personal", true, NOW);
    await setMachineArchived(tenant, "claude", "mac", true, NOW);

    await renameOrMergeGroup(tenant, "Personal", "Home", false, NOW);
    expect(await groupOf("Home")).toMatchObject({ archivedAt: NOW.getTime() });
    expect(await machineOf("claude", "mac")).toMatchObject({ groupId: "Home", archivedAt: NOW.getTime() });
  });

  it("a rename of a group older than colours, which is given one", async () => {
    await getRedis().hset(KEYS.groups, { Legacy: "1000" });
    await renameOrMergeGroup(tenant, "Legacy", "Renamed", false, NOW);
    expect(await groupOf("Renamed")).toEqual({
      groupId: "Renamed",
      color: expect.stringMatching(/^#[0-9a-f]{6}$/),
      firstSeenAt: 1000,
    });
  });

  it("a machine move", async () => {
    await ingest({});
    await ingest({ machineId: "other", groupId: "Work" });
    await setMachineArchived(tenant, "claude", "mac", true, NOW);

    const moved = await moveMachine(
      tenant,
      "claude",
      "mac",
      { groupId: "Work" },
      { merge: false, mode: "snapshot", reset: DEFAULT_RESET, retentionDays: 90, now: NOW },
    );
    expect(moved.ok).toBe(true);
    expect(await machineOf("claude", "mac")).toMatchObject({ groupId: "Work", archivedAt: NOW.getTime() });
  });
});

describe("what leaves archived entries alone", () => {
  useRedis();

  it("the remove-silent-machines button", async () => {
    const staleMs = NOW.getTime() - (INACTIVE_MACHINE_DAYS + 1) * DAY_MS;
    await getRedis().hset(KEYS.groups, {
      Old: serializeGroupEntry("#3987e5", 1, 2),
      Work: serializeGroupEntry("#e5a039", 1),
    });
    await getRedis().hset(KEYS.machines, {
      "claude:own": JSON.stringify({ g: "Work", ts: staleMs, t: 1, ar: 2 }),
      "claude:withgroup": JSON.stringify({ g: "Old", ts: staleMs, t: 1 }),
      "claude:silent": JSON.stringify({ g: "Work", ts: staleMs, t: 1 }),
    });

    expect((await pruneMachines(tenant, NOW, INACTIVE_MACHINE_DAYS)).removedIds).toEqual(["claude:silent"]);
  });

  it("housekeeping", async () => {
    const longAgoMs = NOW.getTime() - 400 * DAY_MS;
    await getRedis().hset(KEYS.groups, {
      Old: serializeGroupEntry("#3987e5", longAgoMs, longAgoMs),
      Dead: serializeGroupEntry("#e5a039", longAgoMs),
    });
    await getRedis().hset(KEYS.machines, {
      "claude:own": JSON.stringify({ g: "Dead", ts: longAgoMs, t: 1, ar: longAgoMs }),
      "claude:withgroup": JSON.stringify({ g: "Old", ts: longAgoMs, t: 1 }),
      "claude:silent": JSON.stringify({ g: "Dead", ts: longAgoMs, t: 1 }),
    });

    const report = await runHousekeeping(tenant, NOW, { dryRun: false });
    expect(report.machines.ids).toEqual(["claude:silent"]);
    expect(report.groups.ids).toEqual(["Dead"]);
    expect(await groupOf("Old")).toMatchObject({ archivedAt: longAgoMs });
  });
});
