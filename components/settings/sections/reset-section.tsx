"use client";

import { useLocale, useTranslations } from "next-intl";
import type { Draft } from "@/components/settings/draft";
import { FIELD } from "@/components/ui/classes";
import { formatMonthDay, weekdayLong } from "@/lib/format";
import { weekdayOrder } from "@/lib/week";

const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

export function ResetSection({
  titleId,
  draft,
  timeZone,
  onPatch,
}: {
  titleId: string;
  draft: Draft;
  timeZone: string;
  onPatch: (changes: Partial<Draft>) => void;
}) {
  const locale = useLocale();
  const t = useTranslations("Settings");

  return (
    <section aria-labelledby={`${titleId}-reset`} className="space-y-4">
      <h3 id={`${titleId}-reset`} className="font-medium">
        {t("reset")}
      </h3>

      <div className="flex flex-wrap gap-x-5 gap-y-4">
        {draft.period === "weekly" ? (
          <label className="block">
            <span className="text-sm text-ink-3">{t("weekday")}</span>
            <select
              value={draft.weekday}
              onChange={(event) => onPatch({ weekday: Number(event.target.value) })}
              className={`mt-1.5 block w-40 ${FIELD}`}
            >
              {/* The week starts where the viewer's locale starts it (Monday in hu/de, Sunday in en-US). */}
              {weekdayOrder(locale).map((weekday) => (
                <option key={weekday} value={weekday}>
                  {weekdayLong(weekday, locale)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="block">
            <span className="text-sm text-ink-3">{t("monthday")}</span>
            <select
              value={draft.monthDay}
              onChange={(event) => onPatch({ monthDay: Number(event.target.value) })}
              className={`mt-1.5 block w-40 tabular-nums ${FIELD}`}
            >
              {MONTH_DAYS.map((day) => (
                <option key={day} value={day}>
                  {formatMonthDay(day, locale)}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block">
          <span className="text-sm text-ink-3">{t("time")}</span>
          <input
            type="time"
            step={60}
            required
            value={draft.time}
            onChange={(event) => onPatch({ time: event.target.value })}
            className={`mt-1.5 block w-32 tabular-nums ${FIELD}`}
          />
        </label>
      </div>

      <p className="text-sm text-ink-3">
        {t("cycle_start_explanation", {
          timeZone,
          monthDay: draft.monthDay,
          monthDayNote: draft.period === "monthly" && draft.monthDay > 28 ? "show" : "other",
        })}
      </p>
    </section>
  );
}
