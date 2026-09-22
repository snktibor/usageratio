"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GroundTruthInput } from "@/components/ground-truth-input";
import { GroupBreakdown } from "@/components/group-breakdown";
import { MachineTable } from "@/components/machine-table";
import { QuotaMeter } from "@/components/quota-meter";
import type { ProviderDashboardModel } from "@/lib/dashboard";
import { formatDateTime, formatTokens } from "@/lib/format";
import { applyGroundTruth, parseOfficialPercent } from "@/lib/ground-truth";

/** The official-usage field: its text as typed, and when that was. */
interface Entry {
  raw: string;
  enteredAt: number | null;
}

const EMPTY: Entry = { raw: "", enteredAt: null };
const STORAGE_KEY = "usageratio:official-usage";
const PROVIDER_KEY = "usageratio:selected-provider";

const MODE_NOTE = {
  delta: "A beküldött tokenszámok összeadódnak (delta mód).",
  snapshot: "Gépenként a ciklus legutolsó beküldött provider-állása számít (snapshot mód).",
  counter: "Gépenként a provider-számláló ciklusbeli növekménye számít (counter mód).",
} as const;

/**
 * The entry survives reloads in localStorage, tagged with the cycle it was
 * read in: an official percentage means nothing once the budget has reset.
 */
function useOfficialEntry(providerId: string, cycleStartMs: number): [Entry, (raw: string) => void] {
  const [entry, setEntry] = useState<Entry>(EMPTY);
  const storageKey = `${STORAGE_KEY}:${providerId}`;

  // Restored after hydration: the server render cannot know the browser's stored entry.
  useEffect(() => {
    let restored = EMPTY;
    try {
      const current = window.localStorage.getItem(storageKey);
      const legacy = providerId === "deepseek" ? window.localStorage.getItem(STORAGE_KEY) : null;
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
  }, [cycleStartMs, providerId, storageKey]);

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

/**
 * The part of the dashboard an official usage figure can restate. The server
 * sends what the machines measured; the recalculation happens here, as the
 * figure is typed.
 */
function ProviderView({
  selected,
  providers,
  onProviderChange,
}: {
  selected: ProviderDashboardModel;
  providers: ProviderDashboardModel[];
  onProviderChange: (providerId: string) => void;
}) {
  const model = selected.dashboard;
  const [entry, setEntry] = useOfficialEntry(selected.id, model.cycle.startMs);
  const { percent, invalid } = parseOfficialPercent(entry.raw);

  const view = useMemo(
    () => applyGroundTruth(model, percent === null ? null : { percent, atMs: entry.enteredAt }),
    [model, percent, entry.enteredAt],
  );

  return (
    <>
      <main className="mt-10 space-y-16 sm:mt-12">
        <div className="space-y-12 sm:space-y-14">
          <GroundTruthInput
            raw={entry.raw}
            onChange={setEntry}
            invalid={invalid}
            enteredAt={entry.enteredAt}
            view={view}
            timeZone={model.timeZone}
            providerId={selected.id}
            providerLabel={selected.label}
            providers={providers.map(({ id, label }) => ({ id, label }))}
            onProviderChange={onProviderChange}
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
              Még egy gép sem jelentett ehhez a fiókhoz
            </h2>
            <p className="mt-3 text-ink-2">
              Telepítsd a klienst a gépeidre a{" "}
              <Link href="/setup" className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink-3">
                Telepítés
              </Link>{" "}
              oldalon: macOS-re és Windowsra is van kész csomag. Az első sikeres beküldés után itt jelenik meg a
              csoportok és a gépek bontása.
            </p>
          </section>
        )}
      </main>
      <footer className="mt-16 max-w-2xl border-t border-hairline pt-6 text-sm leading-relaxed text-ink-3">
        <p>
          A(z) {selected.label} mostani ciklusa: {formatDateTime(model.cycle.startMs, model.timeZone)} –{" "}
          {formatDateTime(model.cycle.endMs, model.timeZone)} ({model.timeZone}). Az előző ciklusban a gépek{" "}
          {formatTokens(model.previousTotal)} tokent mértek.
        </p>
        <p className="mt-1">{MODE_NOTE[model.tokenMode]}</p>
      </footer>
    </>
  );
}

/** Provider switching stays entirely in the browser; every model arrived in the server payload. */
export function DashboardView({ providers }: { providers: ProviderDashboardModel[] }) {
  const [selectedId, setSelectedId] = useState(providers[0]!.id);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PROVIDER_KEY);
      if (stored && providers.some((provider) => provider.id === stored)) setSelectedId(stored);
    } catch {
      // Storage is optional; the first provider remains selected.
    }
  }, [providers]);

  const selectProvider = useCallback((providerId: string) => {
    setSelectedId(providerId);
    try {
      window.localStorage.setItem(PROVIDER_KEY, providerId);
    } catch {
      // The selection still works for this page view.
    }
  }, []);

  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0]!;
  return (
    <ProviderView
      key={selected.id}
      selected={selected}
      providers={providers}
      onProviderChange={selectProvider}
    />
  );
}
