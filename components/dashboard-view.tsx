"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@/i18n/routing";
import { GroundTruthInput } from "@/components/ground-truth-input";
import { GroupBreakdown } from "@/components/group-breakdown";
import { MachineTable } from "@/components/machine-table";
import { ModelChart } from "@/components/model-chart";
import { QuotaMeter } from "@/components/quota-meter";
import { SubLimitMeters, type SubLimitState } from "@/components/sub-limit-meters";
import { UsageChart } from "@/components/usage-chart";
import { EMPTY_ENTRY, useOfficialEntry, useSubLimitEntries } from "@/components/use-official-entry";
import type { TokenMode } from "@/lib/config";
import type { ProviderDashboardModel } from "@/lib/dashboard";
import { formatDateTime, formatTokens } from "@/lib/format";
import { applyGroundTruth, applySubLimitReading, parseOfficialPercent } from "@/lib/ground-truth";
import { useTranslations, useLocale } from "next-intl";

const PROVIDER_KEY = "usageratio:selected-provider";

const MODE_NOTE: Record<TokenMode, string> = {
  delta: "mode_note_delta",
  snapshot: "mode_note_snapshot",
  counter: "mode_note_counter",
};

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
  const locale = useLocale();
  const t = useTranslations("Dashboard");
  const model = selected.dashboard;
  const [entry, setEntry] = useOfficialEntry(selected.id, model.cycle.startMs, selected.officialEntry);
  const { percent, invalid } = parseOfficialPercent(entry.raw);

  const view = useMemo(
    () => applyGroundTruth(model, percent === null ? null : { percent, atMs: entry.enteredAt }),
    [model, percent, entry.enteredAt],
  );

  // Both the fields under the official one and the chart show them: they are worked out here, once.
  const [subEntries, setSubEntry] = useSubLimitEntries(
    selected.id,
    model.cycle.startMs,
    model.subLimits.map((sub) => sub.id),
    selected.subLimitEntries,
  );
  const subLimits = useMemo<SubLimitState[]>(
    () =>
      model.subLimits.map((sub) => {
        const subEntry = subEntries.get(sub.id) ?? EMPTY_ENTRY;
        const parsed = parseOfficialPercent(subEntry.raw);
        const reading = parsed.percent === null ? null : { percent: parsed.percent, atMs: subEntry.enteredAt };
        return { entry: subEntry, invalid: parsed.invalid, view: applySubLimitReading(model, view, sub, reading) };
      }),
    [model, view, subEntries],
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
          >
            <SubLimitMeters model={model} subLimits={subLimits} onChange={setSubEntry} providerLabel={selected.label} />
          </GroundTruthInput>
          <QuotaMeter model={model} view={view} />
          {model.machines.length > 0 && (
            <UsageChart model={model} view={view} subLimits={subLimits.map((state) => state.view)} />
          )}
        </div>

        {model.machines.length > 0 ? (
          <>
            <GroupBreakdown model={model} view={view} />
            <MachineTable model={model} view={view} />
            <ModelChart model={model} />
          </>
        ) : (
          <section aria-labelledby="empty-heading" className="max-w-xl">
            <h2 id="empty-heading" className="text-xl font-medium">
              {t("no_machines_yet")}
            </h2>
            <p className="mt-3 text-ink-2">
              {t("setup_machines_1")}
              <Link
                href="/setup"
                className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink-3"
              >
                {t("setup_machines_2")}
              </Link>{" "}
              {t("setup_machines_3")}
            </p>
          </section>
        )}
      </main>
      <footer className="mt-16 max-w-2xl border-t border-hairline pt-6 text-sm leading-relaxed text-ink-3">
        <p>
          {t("cycle_info", {
            label: selected.label,
            start: formatDateTime(model.cycle.startMs, model.timeZone, locale),
            end: formatDateTime(model.cycle.endMs, model.timeZone, locale),
            timeZone: model.timeZone,
            tokens: formatTokens(model.previousTotal, locale),
          })}
        </p>
        <p className="mt-1">{t(MODE_NOTE[model.tokenMode])}</p>
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
  return <ProviderView key={selected.id} selected={selected} providers={providers} onProviderChange={selectProvider} />;
}
