import { isMachineArchived } from "@/lib/archived";

/**
 * The settings panel's machine list, one row per machine. The index
 * (`usage:machines`) keys a machine by provider and id, so a machine that
 * reports for two providers is two entries there; the panel shows it once,
 * with a tag per provider, and renames or deletes all of its entries together
 * (components/settings/sections/machines-section.tsx).
 */

/** One `usage:machines` entry, as GET /api/machines lists it. */
export interface MachineEntry {
  providerId: string;
  machineId: string;
  groupId: string;
  lastSeenAt: number;
  lastTokens: number;
  /** The entry's own archive mark (lib/archived.ts); absent while active. */
  archivedAt?: number;
}

export interface MachineRow {
  machineId: string;
  /** One per provider, in the order the index listed them. */
  entries: MachineEntry[];
  /** The groups its entries report into, each once: usually just one. */
  groupIds: string[];
  /** The latest report of any of its entries. */
  lastSeenAt: number;
}

/** The entries grouped by machine id, in the order each machine first appears. */
export function machineRows(entries: MachineEntry[]): MachineRow[] {
  const rows = new Map<string, MachineRow>();
  for (const entry of entries) {
    const row = rows.get(entry.machineId);
    if (!row) {
      rows.set(entry.machineId, {
        machineId: entry.machineId,
        entries: [entry],
        groupIds: [entry.groupId],
        lastSeenAt: entry.lastSeenAt,
      });
      continue;
    }
    row.entries.push(entry);
    if (!row.groupIds.includes(entry.groupId)) row.groupIds.push(entry.groupId);
    row.lastSeenAt = Math.max(row.lastSeenAt, entry.lastSeenAt);
  }
  return [...rows.values()];
}

/**
 * The rows split into the listed ones and the archived ones (lib/archived.ts). A row is archived
 * once every entry of it is, by its own mark or its group's: a machine that still reports for one
 * provider stays on the list.
 */
export function splitArchivedRows(
  rows: MachineRow[],
  archivedGroups: ReadonlySet<string>,
): { active: MachineRow[]; archived: MachineRow[] } {
  const active: MachineRow[] = [];
  const archived: MachineRow[] = [];
  for (const row of rows) {
    (row.entries.every((entry) => isMachineArchived(entry, archivedGroups)) ? archived : active).push(row);
  }
  return { active, archived };
}

/**
 * The providers of `row` that already have a machine called `newId`: renaming
 * the row onto it would be refused for them (a machine is never merged, see
 * lib/manage-store.ts), so the rename must not start at all.
 */
export function renameConflicts(entries: MachineEntry[], row: MachineRow, newId: string): string[] {
  return row.entries
    .filter((entry) => entries.some((other) => other.providerId === entry.providerId && other.machineId === newId))
    .map((entry) => entry.providerId);
}
