"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OfficialEntryView } from "@/lib/official-usage";

/** An official-usage field: its text as typed, and when that was. */
export interface Entry {
  raw: string;
  enteredAt: number | null;
}

export const EMPTY_ENTRY: Entry = { raw: "", enteredAt: null };

// Long enough that dragging the slider is not one request per tick; short
// enough that a typed figure reaches the store well before anyone reloads.
const DEBOUNCE_MS = 600;

function toEntry(server: OfficialEntryView | undefined | null): Entry {
  return server ?? EMPTY_ENTRY;
}

async function putOfficialUsage(body: {
  providerId: string;
  subLimitId: string | null;
  raw: string;
  cycleStartMs: number;
}): Promise<void> {
  try {
    await fetch("/api/official-usage", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch {
    // Offline, or the store is down: the figure still works here until the next refresh retries it.
  }
}

/**
 * The official figure of a provider. `server` is what the dashboard's last
 * render read from the store (see lib/official-usage.ts); typing updates the
 * field at once and, after a short pause, writes it back so every browser on
 * the account picks it up on its next refresh. A field mid-edit here is left
 * alone by a `server` change until that edit itself has been sent.
 */
export function useOfficialEntry(
  providerId: string,
  cycleStartMs: number,
  server: OfficialEntryView | null,
): [Entry, (raw: string) => void] {
  const [entry, setEntry] = useState<Entry>(() => toEntry(server));
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only the figure and its time matter, not the object identity
  useEffect(() => {
    if (!pending.current) setEntry(toEntry(server));
  }, [server?.raw, server?.enteredAt]);

  const update = useCallback(
    (raw: string) => {
      const next: Entry = raw.trim() === "" ? EMPTY_ENTRY : { raw, enteredAt: Date.now() };
      setEntry(next);
      pending.current = true;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void putOfficialUsage({ providerId, subLimitId: null, raw: next.raw, cycleStartMs }).finally(() => {
          pending.current = false;
        });
      }, DEBOUNCE_MS);
    },
    [providerId, cycleStartMs],
  );

  return [entry, update];
}

/**
 * The official figures of a provider's sub-limits, by id: one state for all
 * of them, as the settings may add or drop one while the page is open.
 */
export function useSubLimitEntries(
  providerId: string,
  cycleStartMs: number,
  subLimitIds: string[],
  server: Record<string, OfficialEntryView>,
): [Map<string, Entry>, (subLimitId: string, raw: string) => void] {
  // A Map: a sub-limit id such as "constructor" must not find an object's prototype.
  const [entries, setEntries] = useState<Map<string, Entry>>(
    () => new Map(subLimitIds.flatMap((id) => (server[id] ? [[id, server[id]] as const] : []))),
  );
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
      pending.current.add(subLimitId);
      clearTimeout(timers.current.get(subLimitId));
      timers.current.set(
        subLimitId,
        setTimeout(() => {
          void putOfficialUsage({ providerId, subLimitId, raw: next.raw, cycleStartMs }).finally(() => {
            pending.current.delete(subLimitId);
          });
        }, DEBOUNCE_MS),
      );
    },
    [providerId, cycleStartMs],
  );

  return [entries, update];
}
