"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GroundTruthInput } from "@/components/ground-truth-input";
import { GroupBreakdown } from "@/components/group-breakdown";
import { MachineTable } from "@/components/machine-table";
import { QuotaMeter } from "@/components/quota-meter";
import type { DashboardModel } from "@/lib/dashboard";
import { applyGroundTruth, parseOfficialPercent } from "@/lib/ground-truth";

/** The official-usage field: its text as typed, and when that was. */
interface Entry {
  raw: string;
  enteredAt: number | null;
}

const EMPTY: Entry = { raw: "", enteredAt: null };
const STORAGE_KEY = "usageratio:official-usage";

/**
 * The entry survives reloads in localStorage, tagged with the cycle it was
 * read in: an official percentage means nothing once the budget has reset.
 */
function useOfficialEntry(cycleStartMs: number): [Entry, (raw: string) => void] {
  const [entry, setEntry] = useState<Entry>(EMPTY);

  // Restored after hydration: the server render cannot know the browser's stored entry.
  useEffect(() => {
    let restored = EMPTY;
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
      if (typeof stored === "object" && stored !== null) {
        const { raw, enteredAt, cycleStartMs: cycle } = stored as Record<string, unknown>;
        if (cycle === cycleStartMs && typeof raw === "string" && typeof enteredAt === "number") {
          restored = { raw, enteredAt };
        }
      }
      if (restored === EMPTY) window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage is blocked or holds junk: the field simply starts empty.
    }
    setEntry(restored);
  }, [cycleStartMs]);

  const update = useCallback(
    (raw: string) => {
      const next: Entry = raw.trim() === "" ? EMPTY : { raw, enteredAt: Date.now() };
      setEntry(next);
      try {
        if (next === EMPTY) window.localStorage.removeItem(STORAGE_KEY);
        else window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, cycleStartMs }));
      } catch {
        // Not persisted; the entry still works until the page is closed.
      }
    },
    [cycleStartMs],
  );

  return [entry, update];
}

/**
 * The part of the dashboard an official usage figure can restate. The server
 * sends what the machines measured; the recalculation happens here, as the
 * figure is typed.
 */
export function DashboardView({ model }: { model: DashboardModel }) {
  const [entry, setEntry] = useOfficialEntry(model.cycle.startMs);
  const { percent, invalid } = parseOfficialPercent(entry.raw);

  const view = useMemo(
    () => applyGroundTruth(model, percent === null ? null : { percent, atMs: entry.enteredAt }),
    [model, percent, entry.enteredAt],
  );

  return (
    <main className="mt-10 space-y-16 sm:mt-12">
      <div className="space-y-12 sm:space-y-14">
        <GroundTruthInput
          raw={entry.raw}
          onChange={setEntry}
          invalid={invalid}
          enteredAt={entry.enteredAt}
          view={view}
          timeZone={model.timeZone}
        />
        <QuotaMeter model={model} view={view} />
      </div>

      {model.machines.length > 0 ? (
        <>
          <GroupBreakdown model={model} view={view} />
          <MachineTable model={model} view={view} />
        </>
      ) : (
        <section aria-labelledby="empty-heading" className="max-w-xl">
          <h2 id="empty-heading" className="text-xl font-medium">
            Még egy gép sem jelentett
          </h2>
          <p className="mt-3 text-ink-2">
            Telepítsd a kliens szkriptet a gépeidre a repó <code className="text-ink">clients/</code>{" "}
            mappájából. Az első sikeres beküldés után itt jelenik meg a csoportok és a gépek bontása.
          </p>
        </section>
      )}
    </main>
  );
}
