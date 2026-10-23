"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "@/i18n/routing";
import type { OfficialEntryView } from "@/lib/official-usage";

/** An official-usage field: its text as typed, and when that was. */
export interface Entry {
  raw: string;
  enteredAt: number | null;
}

export const EMPTY_ENTRY: Entry = { raw: "", enteredAt: null };

/**
 * Why a save did not reach the store, matching the API route's own
 * rejections (see app/api/official-usage/route.ts): the session lapsed
 * (401), the request itself was refused (400 bad payload, 403 foreign
 * origin), the store could not be reached (5xx), or the request never left
 * the browser at all (offline, or another network failure).
 */
export type SaveProblem = "unauthorized" | "rejected" | "storage" | "network";

/** The field's own save state, independent of what is currently typed into it. */
export interface EntryStatus {
  status: "idle" | "saving" | "saved" | "failed";
  problem: SaveProblem | null;
}

const IDLE_STATUS: EntryStatus = { status: "idle", problem: null };

// Long enough that dragging the slider is not one request per tick; short
// enough that a typed figure reaches the store well before anyone reloads.
const DEBOUNCE_MS = 600;

function toEntry(server: OfficialEntryView | undefined | null): Entry {
  return server ?? EMPTY_ENTRY;
}

type PutResult = { ok: true } | { ok: false; reason: SaveProblem };

/** The current cycle's field (app/api/official-usage/route.ts), or a finished cycle's archived figure (…/archived). */
async function putOfficialUsage(
  path: "/api/official-usage" | "/api/official-usage/archived",
  body: { providerId: string; subLimitId?: string | null; raw: string; cycleStartMs: number; segmentStartMs?: number },
): Promise<PutResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch {
    // Offline, or the store is down: the figure still works here until the next change retries it.
    return { ok: false, reason: "network" };
  }
  if (response.ok) return { ok: true };
  if (response.status === 401) return { ok: false, reason: "unauthorized" };
  // 404: the finished cycle has no archived summary to correct.
  if (response.status === 400 || response.status === 403 || response.status === 404) {
    return { ok: false, reason: "rejected" };
  }
  return { ok: false, reason: "storage" };
}

/**
 * The official figure of a provider. `server` is what the dashboard's last
 * render read from the store (see lib/official-usage.ts); typing updates the
 * field at once and, after a short pause, writes it back so every browser on
 * the account picks it up on its next refresh. A field mid-edit here is left
 * alone by a `server` change until that edit itself has been sent.
 *
 * The returned status reflects only the last write attempt: a fresh change
 * always starts a fresh "saving" attempt, so editing after a failure is
 * itself the retry.
 *
 * `cycleStartMs` is what the figure is tagged with: the start of the current
 * segment (the cycle's, without a usage reset; lib/resets.ts), or a finished
 * cycle's own start.
 *
 * `closedAtMs`, the end of a finished cycle, makes it a correction of the
 * figure archived with that cycle (lib/history.ts): it stands for the cycle's
 * end, not for when it was typed, and once saved the page is refreshed so the
 * previous-cycles list below shows it too (a past cycle has no auto-refresh).
 */
export function useOfficialEntry(
  providerId: string,
  cycleStartMs: number,
  server: OfficialEntryView | null,
  closedAtMs: number | null = null,
): [Entry, (raw: string) => void, EntryStatus] {
  const router = useRouter();
  const [entry, setEntry] = useState<Entry>(() => toEntry(server));
  const [status, setStatus] = useState<EntryStatus>(IDLE_STATUS);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only the figure and its time matter, not the object identity
  useEffect(() => {
    if (!pending.current) setEntry(toEntry(server));
  }, [server?.raw, server?.enteredAt]);

  const update = useCallback(
    (raw: string) => {
      const next: Entry = raw.trim() === "" ? EMPTY_ENTRY : { raw, enteredAt: closedAtMs ?? Date.now() };
      setEntry(next);
      setStatus({ status: "saving", problem: null });
      pending.current = true;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const saved =
          closedAtMs === null
            ? putOfficialUsage("/api/official-usage", { providerId, subLimitId: null, raw: next.raw, cycleStartMs })
            : putOfficialUsage("/api/official-usage/archived", { providerId, raw: next.raw, cycleStartMs });
        void saved
          .then((result) => {
            setStatus(result.ok ? { status: "saved", problem: null } : { status: "failed", problem: result.reason });
            if (result.ok && closedAtMs !== null) router.refresh();
          })
          .finally(() => {
            pending.current = false;
          });
      }, DEBOUNCE_MS);
    },
    [providerId, cycleStartMs, closedAtMs, router],
  );

  return [entry, update, status];
}

/**
 * The official figures of a provider's sub-limits, by id: one state for all
 * of them, as the settings may add or drop one while the page is open. Each
 * id carries its own save status, exactly as `useOfficialEntry` does for the
 * provider's own field.
 */
export function useSubLimitEntries(
  providerId: string,
  cycleStartMs: number,
  subLimitIds: string[],
  server: Record<string, OfficialEntryView>,
): [Map<string, Entry>, (subLimitId: string, raw: string) => void, Map<string, EntryStatus>] {
  // A Map: a sub-limit id such as "constructor" must not find an object's prototype.
  const [entries, setEntries] = useState<Map<string, Entry>>(
    () => new Map(subLimitIds.flatMap((id) => (server[id] ? [[id, server[id]] as const] : []))),
  );
  const [statuses, setStatuses] = useState<Map<string, EntryStatus>>(new Map());
  const pending = useRef<Set<string>>(new Set());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // A stable dependency for the effect: the ids, and the server figures they carry, are new every render.
  const ids = subLimitIds.join("\n");
  const serverKey = subLimitIds.map((id) => `${id}=${server[id]?.raw ?? ""}@${server[id]?.enteredAt ?? ""}`).join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `ids` and `serverKey` stand in for the ever-new `server` object
  useEffect(() => {
    setEntries((current) => {
      const next = new Map(current);
      let changed = false;
      for (const id of ids === "" ? [] : ids.split("\n")) {
        if (pending.current.has(id)) continue;
        const value = server[id];
        if (value) {
          if (current.get(id) !== value) {
            next.set(id, value);
            changed = true;
          }
        } else if (current.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [ids, serverKey]);

  const update = useCallback(
    (subLimitId: string, raw: string) => {
      const next: Entry = raw.trim() === "" ? EMPTY_ENTRY : { raw, enteredAt: Date.now() };
      setEntries((current) => new Map(current).set(subLimitId, next));
      setStatuses((current) => new Map(current).set(subLimitId, { status: "saving", problem: null }));
      pending.current.add(subLimitId);
      clearTimeout(timers.current.get(subLimitId));
      timers.current.set(
        subLimitId,
        setTimeout(() => {
          void putOfficialUsage("/api/official-usage", { providerId, subLimitId, raw: next.raw, cycleStartMs })
            .then((result) =>
              setStatuses((current) =>
                new Map(current).set(
                  subLimitId,
                  result.ok ? { status: "saved", problem: null } : { status: "failed", problem: result.reason },
                ),
              ),
            )
            .finally(() => {
              pending.current.delete(subLimitId);
            });
        }, DEBOUNCE_MS),
      );
    },
    [providerId, cycleStartMs],
  );

  return [entries, update, statuses];
}

/**
 * A finished cycle's figures when it had keep resets, one per segment, keyed
 * by the segment's start (lib/history.ts `CycleSegmentSummary`): each is
 * corrected on its own (app/api/official-usage/archived/route.ts,
 * `segmentStartMs`), and once saved the page is refreshed, so the
 * previous-cycles list shows the new sum. Each start carries its own save
 * status, as `useSubLimitEntries` does for a sub-limit; `server` changes
 * reach a field only while no edit of it is on its way.
 */
export function useSegmentEntries(
  providerId: string,
  cycleStartMs: number,
  segments: { startMs: number; official: number | null }[],
  closedAtMs: number,
): [Map<number, Entry>, (startMs: number, raw: string) => void, Map<number, EntryStatus>] {
  const router = useRouter();
  const toEntry = (official: number | null): Entry =>
    official === null ? EMPTY_ENTRY : { raw: String(official), enteredAt: closedAtMs };
  const [entries, setEntries] = useState<Map<number, Entry>>(
    () => new Map(segments.map((segment) => [segment.startMs, toEntry(segment.official)])),
  );
  const [statuses, setStatuses] = useState<Map<number, EntryStatus>>(new Map());
  const pending = useRef<Set<number>>(new Set());
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  // A stable dependency for the effect: the segments are a new array every render.
  const serverKey = segments.map((segment) => `${segment.startMs}=${segment.official ?? ""}`).join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `serverKey` stands in for the ever-new `segments`
  useEffect(() => {
    setEntries((current) => {
      const next = new Map<number, Entry>();
      for (const segment of segments) {
        next.set(
          segment.startMs,
          pending.current.has(segment.startMs)
            ? (current.get(segment.startMs) ?? EMPTY_ENTRY)
            : toEntry(segment.official),
        );
      }
      return next;
    });
  }, [serverKey]);

  const update = useCallback(
    (startMs: number, raw: string) => {
      const next: Entry = raw.trim() === "" ? EMPTY_ENTRY : { raw, enteredAt: closedAtMs };
      setEntries((current) => new Map(current).set(startMs, next));
      setStatuses((current) => new Map(current).set(startMs, { status: "saving", problem: null }));
      pending.current.add(startMs);
      clearTimeout(timers.current.get(startMs));
      timers.current.set(
        startMs,
        setTimeout(() => {
          void putOfficialUsage("/api/official-usage/archived", {
            providerId,
            raw: next.raw,
            cycleStartMs,
            segmentStartMs: startMs,
          })
            .then((result) => {
              setStatuses((current) =>
                new Map(current).set(
                  startMs,
                  result.ok ? { status: "saved", problem: null } : { status: "failed", problem: result.reason },
                ),
              );
              if (result.ok) router.refresh();
            })
            .finally(() => {
              pending.current.delete(startMs);
            });
        }, DEBOUNCE_MS),
      );
    },
    [providerId, cycleStartMs, closedAtMs, router],
  );

  return [entries, update, statuses];
}
