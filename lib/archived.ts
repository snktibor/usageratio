/**
 * Archived groups and machines: ones the owner knows will not report again.
 * An archived entry leaves the settings panel's lists and pickers (it is
 * folded under "Archived" there, restorable) but keeps everything it stored:
 * its reports, its colour, the past cycles and the all-time totals it is part
 * of, which the dashboard shows just as before. Nothing is deleted, so an
 * archive needs no sudo and is not audited.
 *
 * The mark is an `ar` field (archived at, ms) in the entry itself
 * (`usage:groups` / `usage:machines`, see lib/redis-keys.ts), so a rename, a
 * merge, the trash and an export carry it with the entry. A machine also
 * counts as archived while its group is. A new report clears both marks
 * (`storeReport` in lib/usage-store.ts): something that reports is never
 * hidden. Housekeeping and the "remove silent machines" button leave archived
 * entries alone, so the Archived list does not empty itself.
 */

/** Just what the rule reads from a group. */
export interface ArchivableGroup {
  groupId: string;
  archivedAt?: number;
}

/** Just what the rule reads from a machine entry. */
export interface ArchivableMachine {
  groupId: string;
  archivedAt?: number;
}

/** The ids of the archived groups among `groups`. */
export function archivedGroupIds(groups: readonly ArchivableGroup[]): Set<string> {
  return new Set(groups.filter((group) => group.archivedAt !== undefined).map((group) => group.groupId));
}

/** Whether a machine entry counts as archived: its own mark, or its group's. */
export function isMachineArchived(machine: ArchivableMachine, archivedGroups: ReadonlySet<string>): boolean {
  return machine.archivedAt !== undefined || archivedGroups.has(machine.groupId);
}
