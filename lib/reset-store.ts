import { randomUUID } from "node:crypto";
import type { TimeWindow } from "@/lib/aggregate";
import { type AppConfig, getConfig, type ResetOverride } from "@/lib/config";
import type { Cycle } from "@/lib/cycle";
import { officialUsageField, parseStoredOfficialEntry, serializeOfficialEntry } from "@/lib/official-usage";
import { officialTagAt, providerCycle } from "@/lib/provider-cycles";
import { mergeProviderIds } from "@/lib/providers";
import {
  beforeFromStored,
  deleteReset,
  editReset,
  type ResetChange,
  type ResetContext,
  type ResetDelete,
  type ResetPost,
  type ResetPut,
  type ResetRefusal,
  recordReset,
  retaggedOfficialEntries,
} from "@/lib/reset-recording";
import { addReset, cycleResets, type ProviderResets, type ResetEvent, resetsOf } from "@/lib/resets";
import { ownResetOf, resetModeOf, resolveConfig, storedProviderIds, withResetOverride } from "@/lib/settings";
import { loadIndexes, saveResetChange } from "@/lib/usage-store";

/**
 * The Redis side of usage resets (lib/reset-recording.ts decides): one change
 * written through — the provider's resets, its own reset when a restart moves
 * it, the official figures' tags (the retag rule), and the archived summary of
 * a cycle a restart no longer cuts short where it did — all in one transaction
 * (lib/usage-store.ts `saveResetChange`), so a failed write leaves nothing half
 * done. It is a read-modify-write of one provider's data: two writers racing,
 * the later one wins.
 */

export type ResetAction =
  | { kind: "record"; request: ResetPost }
  | { kind: "edit"; request: ResetPut }
  | { kind: "delete"; request: ResetDelete };

export type ResetActionResult =
  /** `not_found` also stands for a provider the store does not know. */
  { ok: false; refused: ResetRefusal } | { ok: true; events: ResetEvent[]; cycle: TimeWindow };

const windowOf = (cycle: Cycle): TimeWindow => ({ startMs: cycle.start.getTime(), endMs: cycle.end.getTime() });

/**
 * The `usage:official` fields to write for `providerId`: its figures retagged
 * under `config` (the configuration once the change is in), and `extra`
 * written into its own field, tagged the same way.
 */
function officialWrites(
  now: Date,
  config: AppConfig,
  providerId: string,
  events: ResetEvent[],
  stored: Record<string, string>,
  extra: { raw: string; enteredAt: number } | null,
): Record<string, string> {
  const tagAt = officialTagAt(now, config, providerId, events);
  const writes = retaggedOfficialEntries(stored, providerId, tagAt);
  const tag = extra && tagAt(extra.enteredAt);
  if (extra && tag !== null) {
    writes[officialUsageField(providerId, null)] = serializeOfficialEntry({ ...extra, cycleStartMs: tag });
  }
  return writes;
}

/** The figure a change writes into the provider's own field: the one for after the reset, or the one a revert puts back. */
function extraFigure(action: ResetAction, event: ResetEvent): { raw: string; enteredAt: number } | null {
  if (action.kind === "record" && action.request.afterRaw !== undefined) {
    return { raw: action.request.afterRaw, enteredAt: event.atMs };
  }
  if (action.kind === "delete" && action.request.revert && event.before !== null) {
    return { raw: String(event.before), enteredAt: event.beforeAtMs ?? event.atMs };
  }
  return null;
}

export async function applyResetAction(action: ResetAction, now: Date): Promise<ResetActionResult> {
  const { providerId } = action.request;
  const indexes = await loadIndexes();
  const providerIds = mergeProviderIds(
    indexes.providers.map((provider) => provider.providerId),
    storedProviderIds(indexes.settings),
  );
  if (!providerIds.includes(providerId)) return { ok: false, refused: "not_found" };

  const config = resolveConfig(getConfig(), indexes.settings, providerIds);
  const resets = resetsOf(indexes.resets, providerId);
  const ctx: ResetContext = {
    now,
    mode: resetModeOf(config, providerId),
    cycle: windowOf(providerCycle(now, config, providerId, resets.events).cycle),
    resets,
    override: ownResetOf(config, providerId),
    timeZone: config.reset.timeZone,
  };

  let change: ResetChange;
  if (action.kind === "record") {
    const { atMs, before } = action.request;
    const ownRaw = indexes.officialUsage[officialUsageField(providerId, null)];
    const known =
      before === undefined
        ? beforeFromStored(ownRaw ? parseStoredOfficialEntry(ownRaw) : null, ctx.cycle, resets.events, atMs)
        : { before, beforeAtMs: null };
    change = recordReset(ctx, { id: randomUUID(), atMs, ...known, source: "manual" });
  } else if (action.kind === "edit") {
    change = editReset(ctx, action.request);
  } else {
    change = deleteReset(ctx, action.request);
  }
  if (!change.ok) return change;

  const after = change.override === undefined ? config : withResetOverride(config, providerId, change.override);
  await saveResetChange({
    providerId,
    resets: change.resets,
    ...(change.override !== undefined && { override: change.override }),
    rawSettings: indexes.settings,
    providerIds,
    now,
    // The summary archived of the cycle a restart cut short no longer holds once the restart is edited
    // or gone; the next archiving run writes it again from the events (lib/archive.ts).
    ...(action.kind !== "record" &&
      change.event.kind === "restart" && { deleteArchivedStartMs: change.event.cycleStartMs }),
    officialFields: officialWrites(
      now,
      after,
      providerId,
      change.resets.events,
      indexes.officialUsage,
      extraFigure(action, change.event),
    ),
  });

  const cycle = windowOf(providerCycle(now, after, providerId, change.resets.events).cycle);
  return { ok: true, events: cycleResets(cycle, change.resets.events), cycle };
}

/**
 * Records a reset `decideOfficialReport` found in a reading
 * (lib/official-report.ts) under a fresh id, retags the official figures, and
 * moves the provider's own reset to `override` (null: it stays), all in one
 * transaction: the caller must not save the override separately. `rawSettings`
 * and `providerIds` are those read with the request (`loadIndexes`). The caller
 * stores the reading itself.
 */
export async function saveDetectedReset(params: {
  providerId: string;
  config: AppConfig;
  resets: ProviderResets;
  reset: Omit<ResetEvent, "id">;
  override: ResetOverride | null;
  rawSettings: string | null;
  providerIds: string[];
  rawOfficialUsage: Record<string, string>;
  now: Date;
}): Promise<ResetEvent> {
  const { providerId, config, resets, reset, override, rawSettings, providerIds, rawOfficialUsage, now } = params;
  const event: ResetEvent = { id: randomUUID(), ...reset };
  const updated = addReset(resets, event);
  const after = override ? withResetOverride(config, providerId, override) : config;
  await saveResetChange({
    providerId,
    resets: updated,
    ...(override && { override }),
    rawSettings,
    providerIds,
    now,
    officialFields: officialWrites(now, after, providerId, updated.events, rawOfficialUsage, null),
  });
  return event;
}
