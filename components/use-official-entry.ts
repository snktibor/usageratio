"use client";

import { useCallback, useEffect, useState } from "react";

/** An official-usage field: its text as typed, and when that was. */
export interface Entry {
  raw: string;
  enteredAt: number | null;
}

const EMPTY: Entry = { raw: "", enteredAt: null };
const STORAGE_KEY = "usageratio:official-usage";

/**
 * The official figure of a provider, or of one of its sub-limits. The entry
 * survives reloads in localStorage, tagged with the cycle it was read in: an
 * official percentage means nothing once the budget has reset.
 */
export function useOfficialEntry(
  providerId: string,
  cycleStartMs: number,
  subLimitId: string | null = null,
): [Entry, (raw: string) => void] {
  const [entry, setEntry] = useState<Entry>(EMPTY);
  const storageKey = subLimitId === null ? `${STORAGE_KEY}:${providerId}` : `${STORAGE_KEY}:${providerId}:${subLimitId}`;
  // The single key from before there were providers holds DeepSeek's figure.
  const hasLegacy = subLimitId === null && providerId === "deepseek";

  // Restored after hydration: the server render cannot know the browser's stored entry.
  useEffect(() => {
    let restored = EMPTY;
    try {
      const current = window.localStorage.getItem(storageKey);
      const legacy = hasLegacy ? window.localStorage.getItem(STORAGE_KEY) : null;
      const stored: unknown = JSON.parse(current ?? legacy ?? "null");
      if (typeof stored === "object" && stored !== null) {
        const { raw, enteredAt, cycleStartMs: cycle } = stored as Record<string, unknown>;
        if (cycle === cycleStartMs && typeof raw === "string" && typeof enteredAt === "number") {
          restored = { raw, enteredAt };
        }
      }
      if (restored === EMPTY) {
        window.localStorage.removeItem(storageKey);
        if (legacy !== null) window.localStorage.removeItem(STORAGE_KEY);
      } else if (current === null && legacy !== null) {
        window.localStorage.setItem(storageKey, legacy);
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Storage is blocked or holds junk: the field simply starts empty.
    }
    setEntry(restored);
  }, [cycleStartMs, hasLegacy, storageKey]);

  const update = useCallback(
    (raw: string) => {
      const next: Entry = raw.trim() === "" ? EMPTY : { raw, enteredAt: Date.now() };
      setEntry(next);
      try {
        if (next === EMPTY) window.localStorage.removeItem(storageKey);
        else window.localStorage.setItem(storageKey, JSON.stringify({ ...next, cycleStartMs }));
      } catch {
        // Not persisted; the entry still works until the page is closed.
      }
    },
    [cycleStartMs, storageKey],
  );

  return [entry, update];
}
