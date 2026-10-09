"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { CycleHistory } from "@/components/cycle-history";
import { GroundTruthInput } from "@/components/ground-truth-input";
import { GroupBreakdown } from "@/components/group-breakdown";
import { MachineTable } from "@/components/machine-table";
import { ModelChart } from "@/components/model-chart";
import { QuotaMeter } from "@/components/quota-meter";
import { SubLimitMeters, type SubLimitState } from "@/components/sub-limit-meters";
import { UsageChart } from "@/components/usage-chart";
import { EMPTY_ENTRY, useOfficialEntry, useSubLimitEntries } from "@/components/use-official-entry";
import { Link, useRouter } from "@/i18n/routing";
import type { TokenMode } from "@/lib/config";
import type { CycleKind } from "@/lib/cycle-options";
import type { ProviderDashboardModel } from "@/lib/dashboard";
import { formatDateTime, formatTokens } from "@/lib/format";
import { applyGroundTruth, applySubLimitReading, parseOfficialPercent } from "@/lib/ground-truth";
import type { CycleSummary } from "@/lib/history";
import { PROVIDER_COOKIE } from "@/lib/preferences";

const MODE_NOTE = {
  delta: "mode_note_delta",
  snapshot: "mode_note_snapshot",
  counter: "mode_note_counter",
} as const satisfies Record<TokenMode, string>;

/** What the previous-cycles list needs besides the provider's own history. */
export interface HistoryContext {
  /** groupId → colour, for every known group (an archived cycle may name one no longer reporting). */
  groupColors: Record<string, string>;
  /** A cycle's start → how it opens. */
  kinds: Record<number, CycleKind>;
}

/**
 * The part of the dashboard an official usage figure can restate. The server
 * sends what the machines measured; the recalculation happens here, as the
 * figure is typed. A finished cycle (`model.closed`) shows the figure archived
 * with it instead, and takes none.
 */
function ProviderView({
  selected,
  providers,
  history,
  historyContext,
  onProviderChange,
}: {
  selected: ProviderDashboardModel;
  providers: ProviderDashboardModel[];
  history: CycleSummary[];
  historyContext: HistoryContext;
  onProviderChange: (providerId: string) => void;
}) {
  const locale = useLocale();
  const t = useTranslations("Dashboard");
  const model = selected.dashboard;
  const [entry, setEntry, entryStatus] = useOfficialEntry(selected.id, model.cycle.startMs, selected.officialEntry);
  const { percent, invalid } = parseOfficialPercent(entry.raw);

  const view = useMemo(
    () => applyGroundTruth(model, percent === null ? null : { percent, atMs: entry.enteredAt }),
    [model, percent, entry.enteredAt],
  );

  // Both the fields under the official one and the chart show them: they are worked out here, once.
  const [subEntries, setSubEntry, subStatuses] = useSubLimitEntries(
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
        return {
          entry: subEntry,
          invalid: parsed.invalid,
          view: applySubLimitReading(model, view, sub, reading),
          status: subStatuses.get(sub.id) ?? { status: "idle", problem: null },
        };
      }),
    [model, view, subEntries, subStatuses],
  );

  const cycleInfo = {
    label: selected.label,
    start: formatDateTime(model.cycle.startMs, model.timeZone, locale),
    end: formatDateTime(model.cycle.endMs, model.timeZone, locale),
    timeZone: model.timeZone,
    tokens: formatTokens(model.previousTotal, locale),
  };

  return (
    <>
      <main className="mt-10 space-y-16 sm:mt-12">
        <div className="space-y-12 sm:space-y-14">
          <GroundTruthInput
            raw={entry.raw}
            onChange={setEntry}
            invalid={invalid}
            enteredAt={entry.enteredAt}
            status={entryStatus}
            view={view}
            timeZone={model.timeZone}
            providerId={selected.id}
            providerLabel={selected.label}
            providers={providers.map(({ id, label }) => ({ id, label }))}
            onProviderChange={onProviderChange}
            readOnly={model.closed}
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
              {t.rich("setup_machines", {
                link: (chunks) => (
                  <Link
                    href="/setup"
                    className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink-3"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          </section>
        )}
        <CycleHistory
          history={history}
          timeZone={model.timeZone}
          groupColors={historyContext.groupColors}
          kinds={historyContext.kinds}
          selectedStartMs={model.closed ? model.cycle.startMs : null}
        />
      </main>
      <footer className="mt-16 max-w-2xl border-t border-hairline pt-6 text-sm leading-relaxed text-ink-3">
        <p>{model.closed ? t("cycle_info_closed", cycleInfo) : t("cycle_info", cycleInfo)}</p>
        <p className="mt-1">{t(MODE_NOTE[model.tokenMode])}</p>
      </footer>
    </>
  );
}

export function writeProviderCookie(providerId: string) {
  try {
    const oneYear = 60 * 60 * 24 * 365;
    // biome-ignore lint/suspicious/noDocumentCookie: a plain preference cookie; the Cookie Store API is not available everywhere yet
    document.cookie = `${PROVIDER_COOKIE}=${encodeURIComponent(providerId)}; path=/; max-age=${oneYear}; samesite=lax`;
  } catch {
    // Cookies are optional; the selection still works for this page view.
  }
}

/**
 * Provider switching stays entirely in the browser; every model arrived in
 * the server payload. `providers` already has the cookie's provider first
 * (see app/[locale]/(dashboard)/page.tsx), so the very first render picks it correctly.
 * Never rendered without a provider: components/dashboard.tsx shows the
 * empty state instead.
 */
export function DashboardView({
  providers,
  historyByProvider,
  historyContext,
  pastCycle,
}: {
  providers: ProviderDashboardModel[];
  historyByProvider: Record<string, CycleSummary[]>;
  historyContext: HistoryContext;
  pastCycle: boolean;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(providers[0]!.id);

  const selectProvider = useCallback(
    (providerId: string) => {
      writeProviderCookie(providerId);
      setSelectedId(providerId);
      // A past cycle is the selected provider's own: another provider's would be a different week.
      if (pastCycle) router.push("/");
    },
    [pastCycle, router],
  );

  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0]!;
  return (
    <ProviderView
      key={selected.id}
      selected={selected}
      providers={providers}
      history={historyByProvider[selected.id] ?? []}
      historyContext={historyContext}
      onProviderChange={selectProvider}
    />
  );
}
