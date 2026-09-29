"use client";

import { useLocale, useTranslations } from "next-intl";
import { ArrowLeftIcon } from "@/components/icons";
import { StatusLine } from "@/components/status-line";
import { Link } from "@/i18n/routing";
import type { CycleSelection } from "@/lib/cycle-options";
import { formatCycleRange } from "@/lib/format";

/**
 * Above the dashboard, only while a past cycle is open (from the previous
 * cycles at the bottom of the page): which one, what that means (read-only;
 * a summary only, once its reports are gone) and the way back to the current
 * cycle. Also says so when a `?cycle=` named no cycle on offer.
 */
export function CycleBar({
  selection,
  timeZone,
  retentionDays,
}: {
  selection: CycleSelection;
  timeZone: string;
  retentionDays: number;
}) {
  const locale = useLocale();
  const t = useTranslations("Cycles");
  const { selected, unknown } = selection;

  if (unknown) {
    return (
      <div className="mt-8">
        <StatusLine tone="warning">{t("unknown_cycle")}</StatusLine>
      </div>
    );
  }
  if (selected.kind === "current") return null;

  return (
    <div className="mt-8 rounded-lg border border-rule bg-raised px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p className="text-sm text-ink-3">
            {selected.kind === "summary" ? t("summary_banner_title") : t("past_banner_title")}
          </p>
          <p className="mt-0.5 text-lg font-medium tabular-nums text-ink">
            {formatCycleRange(selected.startMs, selected.endMs, timeZone, locale)}
          </p>
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            {selected.kind === "summary" ? t("summary_banner_body", { days: retentionDays }) : t("past_banner_body")}
          </p>
        </div>
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 rounded-md border border-rule px-3 py-1.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
        >
          <ArrowLeftIcon />
          {t("back_to_current")}
        </Link>
      </div>
    </div>
  );
}
