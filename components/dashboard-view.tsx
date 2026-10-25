"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { AllTimeGroups } from "@/components/all-time-groups";
import { CycleHistory } from "@/components/cycle-history";
import { GroundTruthInput } from "@/components/ground-truth-input";
import { GroupBreakdown } from "@/components/group-breakdown";
import { MachineTable } from "@/components/machine-table";
import { ModelChart } from "@/components/model-chart";
import { QuotaMeter } from "@/components/quota-meter";
import { ResetPanel, ResetPrompt } from "@/components/reset-panel";
import { SegmentFigures } from "@/components/segment-figures";
import { SubLimitMeters, type SubLimitState } from "@/components/sub-limit-meters";
import { UsageChart } from "@/components/usage-chart";
import { EMPTY_ENTRY, useOfficialEntry, useSegmentEntries, useSubLimitEntries } from "@/components/use-official-entry";
import { useResetPrompt } from "@/components/use-reset-prompt";
import { Link, useRouter } from "@/i18n/routing";
import type { AllTimeSummary } from "@/lib/all-time";
import type { TokenMode } from "@/lib/config";
import type { CycleKind } from "@/lib/cycle-options";
import { type ProviderDashboardModel, segmentSince } from "@/lib/dashboard";
import { formatDateTime, formatTokens } from "@/lib/format";
import { applyGroundTruth, applySegmentFigures, applySubLimitReading, parseOfficialPercent } from "@/lib/ground-truth";
import { type CycleSummary, sumOfFigures } from "@/lib/history";
import { PROVIDER_COOKIE } from "@/lib/preferences";

const MODE_NOTE = {
  delta: "mode_note_delta",
  snapshot: "mode_note_snapshot",
  counter: "mode_note_counter",
} as const satisfies Record<TokenMode, string>;

/** What the previous-cycles list, and the all-time totals under it, need besides the provider's own history. */
export interface HistoryContext {
  /** groupId → colour, for every known group (an archived cycle may name one no longer reporting). */
  groupColors: Record<string, string>;
  /** A cycle's start → how it opens. */
  kinds: Record<number, CycleKind>;
  /** Every visible provider's all-time totals by group (lib/all-time.ts); null, or missing, while it has none. */
  allTimeByProvider: Record<string, AllTimeSummary | null>;
}

/**
 * The part of the dashboard an official usage figure can restate. The server
 * sends what the machines measured; the recalculation happens here, as the
 * figure is typed. A finished cycle (`model.closed`) shows the figure archived
 * with it instead, which can still be corrected.
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
  // A figure belongs to the segment it was typed in (lib/resets.ts): it clears itself at a reset. A closed
  // cycle's segment is the whole cycle, whose start keys its archived summary.
  const [entry, setEntry, entryStatus] = useOfficialEntry(
    selected.id,
    model.segment.startMs,
    selected.officialEntry,
    // A finished cycle's figure is its archived one: a correction is written there.
    model.closed ? model.cycle.endMs : null,
  );
  const { percent, invalid } = parseOfficialPercent(entry.raw);
  // A closed cycle with keep resets came to the sum of its segments' figures, each corrected on its own.
  const { pastSegments } = model;
  const segmented = pastSegments.length > 0;
  const [segmentEntries, setSegmentEntry, segmentStatuses] = useSegmentEntries(
    selected.id,
    model.cycle.startMs,
    pastSegments,
    model.cycle.endMs,
  );
  const segmentFigures = useMemo(
    () =>
      pastSegments.map(
        (segment) => parseOfficialPercent((segmentEntries.get(segment.startMs) ?? EMPTY_ENTRY).raw).percent,
      ),
    [pastSegments, segmentEntries],
  );
  const segmentSum = sumOfFigures(segmentFigures);
  // "Was there a reset?": asked once an edit takes the figure low and its save has settled. Only an open
  // cycle's edit counts, and only within its segment: the view stays mounted when the page changes cycle.
  const resetPrompt = useResetPrompt(
    percent,
    entryStatus.status === "saving",
    `${model.closed}:${model.segment.startMs}`,
  );
  const { beginEdit } = resetPrompt;
  const changeEntry = useCallback(
    (raw: string) => {
      if (!model.closed) beginEdit();
      setEntry(raw);
    },
    [model.closed, beginEdit, setEntry],
  );

  const view = useMemo(
    () =>
      segmented
        ? applySegmentFigures(model, segmentFigures)
        : applyGroundTruth(model, percent === null ? null : { percent, atMs: entry.enteredAt }),
    [segmented, model, segmentFigures, percent, entry.enteredAt],
  );

  // Both the fields under the official one and the chart show them: they are worked out here, once.
  const [subEntries, setSubEntry, subStatuses] = useSubLimitEntries(
    selected.id,
    model.segment.startMs,
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
            raw={segmented ? (segmentSum === null ? "" : String(segmentSum)) : entry.raw}
            onChange={changeEntry}
            invalid={segmented ? false : invalid}
            enteredAt={entry.enteredAt}
            status={entryStatus}
            view={view}
            timeZone={model.timeZone}
            providerId={selected.id}
            providerLabel={selected.label}
            providers={providers.map(({ id, label }) => ({ id, label }))}
            onProviderChange={onProviderChange}
            readOnly={model.closed}
            since={segmentSince(model)}
            correction={
              segmented && (
                <SegmentFigures
                  segments={pastSegments}
                  entries={segmentEntries}
                  statuses={segmentStatuses}
                  onChange={setSegmentEntry}
                  timeZone={model.timeZone}
                />
              )
            }
            belowField={
              !model.closed &&
              resetPrompt.from !== null && (
                <ResetPrompt
                  providerId={selected.id}
                  providerLabel={selected.label}
                  before={resetPrompt.from}
                  afterRaw={entry.raw}
                  onDone={resetPrompt.dismiss}
                />
              )
            }
          >
            <SubLimitMeters model={model} subLimits={subLimits} onChange={setSubEntry} providerLabel={selected.label} />
            {/* Resets are recorded in the current cycle only. */}
            {!model.closed && (
              <ResetPanel
                providerId={selected.id}
                providerLabel={selected.label}
                model={model}
                resetMode={selected.resetMode}
                entry={entry}
              />
            )}
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
        <AllTimeGroups
          summary={historyContext.allTimeByProvider[selected.id] ?? null}
          timeZone={model.timeZone}
          groupColors={historyContext.groupColors}
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
