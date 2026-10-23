"use client";

import { useLocale, useTranslations } from "next-intl";
import { StatusLine } from "@/components/status-line";
import { EMPTY_ENTRY, type Entry, type EntryStatus } from "@/components/use-official-entry";
import { formatCycleRange } from "@/lib/format";
import { parseOfficialPercent } from "@/lib/ground-truth";

/**
 * A finished cycle with keep resets, corrected one segment at a time: a field
 * per stretch between its resets, labelled with when it ran
 * (components/use-official-entry.ts `useSegmentEntries` keeps and saves them).
 */
export function SegmentFigures({
  segments,
  entries,
  statuses,
  onChange,
  timeZone,
}: {
  segments: { startMs: number; endMs: number }[];
  entries: Map<number, Entry>;
  statuses: Map<number, EntryStatus>;
  onChange: (startMs: number, raw: string) => void;
  timeZone: string;
}) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  return (
    <div>
      <p className="max-w-3xl text-sm text-ink-3">{t("segment_figures_hint")}</p>
      <ul className="mt-3 space-y-3">
        {segments.map((segment) => {
          const entry = entries.get(segment.startMs) ?? EMPTY_ENTRY;
          const { invalid } = parseOfficialPercent(entry.raw);
          const status = statuses.get(segment.startMs);
          return (
            <li key={segment.startMs}>
              <label className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <span className="sr-only">{t("segment_figure_label")}</span>
                <span className="min-w-56 text-sm text-ink-2 tabular-nums">
                  {formatCycleRange(segment.startMs, segment.endMs, timeZone, locale)}
                </span>
                <span className="relative">
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    maxLength={7}
                    placeholder="–"
                    value={entry.raw}
                    onChange={(event) => onChange(segment.startMs, event.target.value)}
                    aria-invalid={invalid || undefined}
                    className="block w-24 rounded-md border border-rule bg-page py-1 pl-3 pr-8 text-lg font-medium tabular-nums text-ink placeholder:text-ink-3"
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ink-3"
                  >
                    %
                  </span>
                </span>
              </label>
              {invalid && <p className="mt-1 text-sm text-ink">{t("number_between_0_100")}</p>}
              {status?.status === "failed" && status.problem && (
                <div className="mt-1">
                  <StatusLine tone="problem">{t(`official_save_failed_${status.problem}`)}</StatusLine>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
