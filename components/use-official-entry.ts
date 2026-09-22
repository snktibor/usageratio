"use client";

import { useCallback, useEffect, useState } from "react";

/** An official-usage field: its text as typed, and when that was. */
export interface Entry {
  raw: string;
  enteredAt: number | null;
}

export const EMPTY_ENTRY: Entry = { raw: "", enteredAt: null };
const STORAGE_KEY = "usageratio:official-usage";

/** The stored entry, if it was typed in this cycle; null otherwise. */
function readEntry(stored: string | null, cycleStartMs: number): Entry | null {
  const value: unknown = JSON.parse(stored ?? "null");
  if (typeof value !== "object" || value === null) return null;
  const { raw, enteredAt, cycleStartMs: cycle } = value as Record<string, unknown>;
  return cycle === cycleStartMs && typeof raw === "string" && typeof enteredAt === "number" ? { raw, enteredAt } : null;
}

function writeEntry(storageKey: string, entry: Entry, cycleStartMs: number): void {
  try {
    if (entry === EMPTY_ENTRY) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, JSON.stringify({ ...entry, cycleStartMs }));
  } catch {
    // Not persisted; the entry still works until the page is closed.
  }
}

/**
 * The official figure of a provider. The entry survives reloads in
 * localStorage, tagged with the cycle it was read in: an official percentage
 * means nothing once the budget has reset.
 */
export function useOfficialEntry(providerId: string, cycleStartMs: number): [Entry, (raw: string) => void] {
  const [entry, setEntry] = useState<Entry>(EMPTY_ENTRY);
  const storageKey = `${STORAGE_KEY}:${providerId}`;
  // The single key from before there were providers holds DeepSeek's figure.
  const hasLegacy = providerId === "deepseek";

  // Restored after hydration: the server render cannot know the browser's stored entry.
  useEffect(() => {
    let restored = EMPTY_ENTRY;
    try {
      const current = window.localStorage.getItem(storageKey);
      const legacy = hasLegacy ? window.localStorage.getItem(STORAGE_KEY) : null;
      restored = readEntry(current ?? legacy, cycleStartMs) ?? EMPTY_ENTRY;
      if (restored === EMPTY_ENTRY) {
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
      const next: Entry = raw.trim() === "" ? EMPTY_ENTRY : { raw, enteredAt: Date.now() };
      setEntry(next);
      writeEntry(storageKey, next, cycleStartMs);
    },
    [cycleStartMs, storageKey],
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
): [Map<string, Entry>, (subLimitId: string, raw: string) => void] {
  // A Map: a sub-limit id such as "constructor" must not find an object's prototype.
  const [entries, setEntries] = useState<Map<string, Entry>>(() => new Map());
  const keyOf = useCallback((subLimitId: string) => `${STORAGE_KEY}:${providerId}:${subLimitId}`, [providerId]);
  // A stable dependency for the effect: the ids themselves are a new array on every render.
  const ids = subLimitIds.join("\n");

  // Restored after hydration: the server render cannot know the browser's stored entries.
  useEffect(() => {
    const restored = new Map<string, Entry>();
    for (const subLimitId of ids === "" ? [] : ids.split("\n")) {
      try {
        const entry = readEntry(window.localStorage.getItem(keyOf(subLimitId)), cycleStartMs);
        if (entry) restored.set(subLimitId, entry);
        else window.localStorage.removeItem(keyOf(subLimitId));
      } catch {
        // Storage is blocked or holds junk: the field simply starts empty.
      }
    }
    setEntries(restored);
  }, [cycleStartMs, ids, keyOf]);

  const update = useCallback(
    (subLimitId: string, raw: string) => {
      const next: Entry = raw.trim() === "" ? EMPTY_ENTRY : { raw, enteredAt: Date.now() };
      setEntries((current) => new Map(current).set(subLimitId, next));
      writeEntry(keyOf(subLimitId), next, cycleStartMs);
    },
    [cycleStartMs, keyOf],
  );

  return [entries, update];
}
