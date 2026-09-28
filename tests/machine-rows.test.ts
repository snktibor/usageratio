import { describe, expect, it } from "vitest";
import { type MachineEntry, machineRows, renameConflicts } from "@/lib/machine-rows";

function entry(providerId: string, machineId: string, overrides: Partial<MachineEntry> = {}): MachineEntry {
  return { providerId, machineId, groupId: "Personal", lastSeenAt: 1_000, lastTokens: 0, ...overrides };
}

describe("machineRows", () => {
  it("lists a machine once, however many providers it reports for", () => {
    const rows = machineRows([
      entry("claude", "mac", { lastSeenAt: 3_000 }),
      entry("openai", "mac", { lastSeenAt: 5_000 }),
      entry("claude", "pc"),
      entry("deepseek", "mac", { lastSeenAt: 4_000 }),
    ]);

    expect(rows.map((row) => row.machineId)).toEqual(["mac", "pc"]);
    expect(rows[0]!.entries.map((e) => e.providerId)).toEqual(["claude", "openai", "deepseek"]);
    expect(rows[0]!.lastSeenAt).toBe(5_000);
    expect(rows[1]!.entries).toHaveLength(1);
  });

  it("keeps every group a machine reports into, each once", () => {
    const [row] = machineRows([
      entry("claude", "mac", { groupId: "Work" }),
      entry("openai", "mac", { groupId: "Personal" }),
      entry("deepseek", "mac", { groupId: "Work" }),
    ]);
    expect(row!.groupIds).toEqual(["Work", "Personal"]);
  });

  it("is empty for no entries", () => {
    expect(machineRows([])).toEqual([]);
  });
});

describe("renameConflicts", () => {
  const entries = [entry("claude", "mac"), entry("openai", "mac"), entry("openai", "mac-2"), entry("claude", "pc")];
  const [mac] = machineRows(entries);

  it("names the providers that already have a machine with the new id", () => {
    expect(renameConflicts(entries, mac!, "mac-2")).toEqual(["openai"]);
    expect(renameConflicts(entries, mac!, "pc")).toEqual(["claude"]);
  });

  it("is empty when the new id is free for every provider of the machine", () => {
    expect(renameConflicts(entries, mac!, "mac-3")).toEqual([]);
  });

  it("ignores providers the machine does not report for", () => {
    const [pc] = machineRows([entry("claude", "pc"), entry("openai", "laptop")]);
    expect(renameConflicts([entry("claude", "pc"), entry("openai", "laptop")], pc!, "laptop")).toEqual([]);
  });
});
