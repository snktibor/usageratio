"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { ArrowLeftIcon, HistoryIcon } from "@/components/icons";
import { StatusLine } from "@/components/status-line";
import { Link, useRouter } from "@/i18n/routing";
import type { CycleOption, CycleSelection } from "@/lib/cycle-options";
import { formatCycleRange } from "@/lib/format";

/** Where a cycle opens: the dashboard itself for the current one, `?cycle=<start>` for the others. */
export const cycleHref = (option: Pick<CycleOption, "kind" | "startMs">) =>
  option.kind === "current" ? "/" : `/?cycle=${option.startMs}`;

/**
 * Above the dashboard: which cycle is on screen, a picker for the others and,
 * while a past one is open, what that means (read-only; a summary only, once
 * its reports are gone) and the way back to the current cycle.
 */
export function CycleBar({
  options,
  selection,
  timeZone,
  retentionDays,
}: {
  options: CycleOption[];
  selection: CycleSelection;
  timeZone: string;
  retentionDays: number;
}) {
  const locale = useLocale();
  const t = useTranslations("Cycles");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { selected, unknown } = selection;
  const past = selected.kind !== "current";
  const range = (option: CycleOption) => formatCycleRange(option.startMs, option.endMs, timeZone, locale);

  // Nothing to pick while there is only the current cycle.
  if (options.length < 2 && !unknown) return null;

  return (
    <div className="mt-8 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-0 max-w-full items-center gap-2 text-sm text-ink-3">
          <HistoryIcon className="shrink-0" />
          <span aria-hidden="true" className="shrink-0">
            {t("picker_label")}
          </span>
          <select
            aria-label={t("picker_label")}
            value={selected.startMs}
            disabled={pending}
            onChange={(event) => {
              const option = options.find((candidate) => candidate.startMs === Number(event.target.value));
              if (option) startTransition(() => router.push(cycleHref(option)));
            }}
            className="min-w-0 max-w-full truncate rounded-md border border-rule bg-page px-3 py-2 text-ink outline-none transition-colors hover:border-ink-3 focus:border-ink-3 disabled:opacity-50"
          >
            {options.map((option) => (
              <option key={option.startMs} value={option.startMs}>
                {option.kind === "current"
                  ? t("picker_current", { range: range(option) })
                  : option.kind === "summary"
                    ? t("picker_summary", { range: range(option) })
                    : range(option)}
              </option>
            ))}
          </select>
        </label>
        {past && (
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md border border-rule px-3 py-1.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
          >
            <ArrowLeftIcon />
            {t("back_to_current")}
          </Link>
        )}
      </div>

      {past && (
        <div className="rounded-lg border border-rule bg-raised px-4 py-3 sm:px-5">
          <p className="text-sm text-ink-3">
            {selected.kind === "summary" ? t("summary_banner_title") : t("past_banner_title")}
          </p>
          <p className="mt-0.5 text-lg font-medium tabular-nums text-ink">{range(selected)}</p>
          <p className="mt-1 text-sm text-ink-2">
            {selected.kind === "summary" ? t("summary_banner_body", { days: retentionDays }) : t("past_banner_body")}
          </p>
        </div>
      )}

      {unknown && <StatusLine tone="warning">{t("unknown_cycle")}</StatusLine>}
    </div>
  );
}
