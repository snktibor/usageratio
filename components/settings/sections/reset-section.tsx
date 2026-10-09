"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { type Draft, type DraftOwnReset, parseTimeZone } from "@/components/settings/draft";
import { StatusLine } from "@/components/status-line";
import { FIELD, QUIET_BUTTON } from "@/components/ui/classes";
import { Segmented } from "@/components/ui/segmented";
import { formatMonthDay, weekdayLong } from "@/lib/format";
import { weekdayOrder } from "@/lib/week";

const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

/**
 * Every IANA zone the browser knows, the browser's own first, then UTC, with
 * the saved one kept even if this browser does not list it. Only computed in
 * the browser, after hydration: the server's zone list and its own time zone
 * are not the visitor's.
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
  onOwnReset,
  onPatchOwnReset,
}: {
  titleId: string;
  draft: Draft;
  onPatch: (changes: Partial<Draft>) => void;
  onOwnReset: (providerId: string, own: boolean) => void;
  onPatchOwnReset: (providerId: string, changes: Partial<Omit<DraftOwnReset, "source">>) => void;
}) {
  const locale = useLocale();
  const t = useTranslations("Settings");
  const [detected, setDetected] = useState<string | null>(null);
  const [zones, setZones] = useState<string[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list is built once per page load; the saved zone only seeds it
  useEffect(() => {
    const zone = browserTimeZone();
    setDetected(zone);
    setZones(timeZoneOptions(draft.timeZone, zone));
  }, []);
  const zoneListId = useId();
  const periodName = useId();
  const zoneInvalid = parseTimeZone(draft.timeZone) === null;

  return (
    <section aria-labelledby={`${titleId}-reset`} className="space-y-4">
      <h3 id={`${titleId}-reset`} className="font-medium">
        {t("cycle_heading")}
      </h3>

      {/* The cycle's length sits with its reset: the budget's limits only read it. */}
      <fieldset>
        <legend className="text-sm text-ink-3">{t("type")}</legend>
        <Segmented
          name={periodName}
          value={draft.period}
          onChange={(period) => onPatch({ period })}
          className="mt-1.5"
          options={[
            { value: "weekly", label: t("weekly") },
            { value: "monthly", label: t("monthly") },
          ]}
        />
      </fieldset>

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

      {draft.providers.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="text-sm text-ink-3">{t("reset_per_provider_heading")}</legend>
          {draft.providers.map((provider) => {
            const own = Object.hasOwn(draft.resetOverrides, provider.id)
              ? draft.resetOverrides[provider.id]
              : undefined;
            const when =
              draft.period === "weekly"
                ? `${weekdayLong(draft.weekday, locale)} ${draft.time}`
                : `${formatMonthDay(draft.monthDay, locale)} ${draft.time}`;
            return (
              <div key={provider.id} className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <label className="flex w-40 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={own !== undefined}
                    onChange={(event) => onOwnReset(provider.id, event.target.checked)}
                    aria-label={t("reset_own", { label: provider.label })}
                  />
                  <span className="truncate">{provider.label}</span>
                  <span className="text-sm text-ink-3">{t("reset_own_short")}</span>
                </label>
                {own ? (
                  <>
                    {draft.period === "weekly" ? (
                      <select
                        aria-label={t("reset_own_day", { label: provider.label })}
                        value={own.weekday}
                        onChange={(event) => onPatchOwnReset(provider.id, { weekday: Number(event.target.value) })}
                        className={`w-40 ${FIELD}`}
                      >
                        {weekdayOrder(locale).map((weekday) => (
                          <option key={weekday} value={weekday}>
                            {weekdayLong(weekday, locale)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <select
                        aria-label={t("reset_own_day", { label: provider.label })}
                        value={own.monthDay}
                        onChange={(event) => onPatchOwnReset(provider.id, { monthDay: Number(event.target.value) })}
                        className={`w-40 tabular-nums ${FIELD}`}
                      >
                        {MONTH_DAYS.map((day) => (
                          <option key={day} value={day}>
                            {formatMonthDay(day, locale)}
                          </option>
                        ))}
                      </select>
                    )}
                    <input
                      type="time"
                      step={60}
                      required
                      aria-label={t("reset_own_time", { label: provider.label })}
                      value={own.time}
                      onChange={(event) => onPatchOwnReset(provider.id, { time: event.target.value })}
                      className={`w-32 tabular-nums ${FIELD}`}
                    />
                    {own.source === "report" && (
                      <span className="basis-full text-sm text-ink-3 sm:pl-40">
                        <span aria-hidden="true">↳ </span>
                        {t("reset_set_by_report")}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-sm text-ink-3">{t("reset_shared_hint", { when })}</span>
                )}
              </div>
            );
          })}
        </fieldset>
      )}
    </section>
  );
}
