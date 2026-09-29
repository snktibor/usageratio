"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useMemo } from "react";
import { type Draft, parseTimeZone } from "@/components/settings/draft";
import { StatusLine } from "@/components/status-line";
import { FIELD, QUIET_BUTTON } from "@/components/ui/classes";
import { formatMonthDay, weekdayLong } from "@/lib/format";
import { weekdayOrder } from "@/lib/week";

const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

/**
 * Every IANA zone the browser knows, the browser's own first, then UTC, with
 * the saved one kept even if this browser does not list it. Only computed in
 * the browser: the form is mounted when the dialog opens, never during server
 * rendering.
 */
function timeZoneOptions(current: string, detected: string | null): string[] {
  const known = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [
    ...new Set([...(detected ? [detected] : []), "UTC", ...(known.includes(current) ? [] : [current]), ...known]),
  ];
}

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

export function ResetSection({
  titleId,
  draft,
  onPatch,
}: {
  titleId: string;
  draft: Draft;
  onPatch: (changes: Partial<Draft>) => void;
}) {
  const locale = useLocale();
  const t = useTranslations("Settings");
  const detected = useMemo(browserTimeZone, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list is built once per opening; the saved zone only seeds it
  const zones = useMemo(() => timeZoneOptions(draft.timeZone, detected), []);
  const zoneListId = useId();
  const zoneInvalid = parseTimeZone(draft.timeZone) === null;

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

        <label className="block min-w-0">
          <span className="text-sm text-ink-3">{t("timezone_label")}</span>
          {/* A searchable field, not a <select>: a list of ~400 zones filled the whole screen. */}
          <input
            type="text"
            list={zoneListId}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("timezone_placeholder")}
            value={draft.timeZone}
            onChange={(event) => onPatch({ timeZone: event.target.value })}
            onFocus={(event) => event.currentTarget.select()}
            aria-invalid={zoneInvalid || undefined}
            className={`mt-1.5 block w-64 max-w-full ${FIELD}`}
          />
          <datalist id={zoneListId}>
            {zones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </label>
      </div>

      {zoneInvalid && <StatusLine tone="problem">{t("timezone_invalid")}</StatusLine>}

      {detected && detected !== draft.timeZone && (
        <button type="button" onClick={() => onPatch({ timeZone: detected })} className={`text-sm ${QUIET_BUTTON}`}>
          {t("timezone_use_detected", { zone: detected.replaceAll("_", " ") })}
        </button>
      )}

      <p className="text-sm text-ink-3">
        {t("cycle_start_explanation", {
          timeZone: draft.timeZone,
          monthDay: draft.monthDay,
          monthDayNote: draft.period === "monthly" && draft.monthDay > 28 ? "show" : "other",
        })}
      </p>
    </section>
  );
}
