"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { StopCircleIcon } from "@/components/icons";
import { StatusLine } from "@/components/status-line";
import type { EntryStatus } from "@/components/use-official-entry";
import { formatDateTime, formatFactor, formatHeroPercent, formatPercent, formatTokens } from "@/lib/format";
import type { DashboardView } from "@/lib/ground-truth";
import type { Translator } from "@/lib/i18n";

interface GroundTruthInputProps {
  /** The field's text, exactly as typed. */
  raw: string;
  onChange: (raw: string) => void;
  invalid: boolean;
  /** When the current text was entered; null while the field is empty. */
  enteredAt: number | null;
  /** Whether the field's last write reached the store, and why not when it did not. */
  status: EntryStatus;
  view: DashboardView;
  timeZone: string;
  providerId: string;
  providerLabel: string;
  providers: { id: string; label: string }[];
  onProviderChange: (providerId: string) => void;
  /** Under the field: the provider's sub-limits, if it has any. */
  children?: React.ReactNode;
  /** Right under the field's hint: the "Was there a reset?" question (components/reset-panel.tsx), when it stands. */
  belowField?: React.ReactNode;
  /**
   * A finished cycle with keep resets: what Correct opens instead of the
   * single field — one field per segment (components/segment-figures.tsx).
   */
  correction?: React.ReactNode;
  /**
   * A finished cycle: the figure archived with it is shown, and only edited
   * once asked to (a correction, say 82% → 100%, of a figure that went stale
   * before the reset; see components/use-official-entry.ts `closedAtMs`).
   */
  readOnly?: boolean;
  /** What the measured figures count from (lib/dashboard.ts `segmentSince`): a keep reset, or the cycle's start. */
  since: "reset" | "cycle";
}

function hint(
  { invalid, enteredAt, view, timeZone, providerLabel, readOnly: readOnlyCycle, since }: GroundTruthInputProps,
  correcting: boolean,
  t: Translator<"Widgets">,
  locale: string,
): string {
  if (invalid) return t("number_between_0_100");
  if (readOnlyCycle && !view.calibrated) {
    return correcting
      ? t("official_correct_hint", { label: providerLabel })
      : t("official_not_archived", { label: providerLabel });
  }
  if (!view.calibrated) {
    if (!view.inTokens) {
      return t("enter_official_no_token", { label: providerLabel });
    }
    return t("enter_official_with_token", { label: providerLabel });
  }

  // An archived figure's only date is the end of its cycle: "entered at" would not be true.
  const entered =
    enteredAt === null || readOnlyCycle ? "" : t("entered_at", { time: formatDateTime(enteredAt, timeZone, locale) });
  if (view.measured.total === 0) {
    return t("no_consumption_yet", { since, entered });
  }
  // Without a token limit there is neither a measured share of the limit nor a factor to state.
  if (view.scale === null || view.measured.usedFraction === null) {
    return t("measured_ratio_only", { tokens: formatTokens(view.measured.total, locale), entered });
  }
  return t("measured_and_scaled", {
    tokens: formatTokens(view.measured.total, locale),
    fraction: formatPercent(view.measured.usedFraction, locale),
    factor: formatFactor(view.scale, locale),
    entered,
  });
}

/**
 * The official usage figure, typed or dragged. The page leads with it on
 * purpose: while it is filled in, every figure below is restated by it.
 */
export function GroundTruthInput(props: GroundTruthInputProps) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const { raw, onChange, invalid, status, view, providerId, providerLabel, providers, onProviderChange, readOnly } =
    props;
  const fieldId = useId();
  const hintId = useId();
  const [correcting, setCorrecting] = useState(false);
  const editable = !readOnly || correcting;

  // Left alone, the slider rests on the measured figure (on 0 without a token limit): dragging starts from what is known.
  const sliderFraction = (view.calibrated ? view.quota?.usedFraction : view.measured.usedFraction) ?? 0;
  const sliderValue = Math.min(1, sliderFraction) * 100;

  return (
    <section
      aria-label={t("official_consumption_aria", { label: providerLabel })}
      className={`rounded-lg border bg-raised px-5 py-5 transition-colors sm:px-6 ${
        view.calibrated ? "border-ink-3" : "border-rule"
      }`}
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-4">
        {readOnly && !correcting ? (
          <h2 className="text-base font-medium">{t("final_official_consumption")}</h2>
        ) : readOnly ? (
          <label htmlFor={fieldId} className="text-base font-medium">
            {t("final_official_consumption")}
          </label>
        ) : (
          <label htmlFor={fieldId} className="text-base font-medium">
            {t("current_official_consumption")}
          </label>
        )}
        <label className="flex items-center gap-2 text-sm text-ink-3">
          <span>{t("ai_account")}</span>
          <select
            value={providerId}
            onChange={(event) => onProviderChange(event.target.value)}
            className="rounded-md border border-rule bg-page px-3 py-2 font-medium text-ink outline-none transition-colors hover:border-ink-3 focus:border-ink-3"
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!editable ? (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-sm text-ink-3">{t("real_percentage", { label: providerLabel })}</span>
          <span className={`text-2xl font-medium tabular-nums ${raw === "" ? "text-ink-3" : "text-ink"}`}>
            {raw === "" ? "–" : formatHeroPercent(Number(raw) / 100, locale)}
          </span>
          <button
            type="button"
            onClick={() => setCorrecting(true)}
            className="ml-auto shrink-0 self-center rounded-md border border-rule px-3 py-1.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
          >
            {t("official_correct")}
          </button>
        </div>
      ) : readOnly && props.correction ? (
        <div className="flex flex-wrap items-start justify-between gap-4">
          {props.correction}
          <button
            type="button"
            onClick={() => setCorrecting(false)}
            className="rounded-md border border-rule px-3 py-1.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
          >
            {t("official_correct_done")}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <span className="text-sm text-ink-3">{t("real_percentage", { label: providerLabel })}</span>

          {/* One row from `sm` up. On a phone the slider gets a row of its own: it has to be draggable by thumb. */}
          <div className="flex min-w-64 grow flex-wrap items-center gap-4 sm:flex-nowrap">
            <span className="relative shrink-0">
              <input
                id={fieldId}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                maxLength={7}
                placeholder="–"
                value={raw}
                onChange={(event) => onChange(event.target.value)}
                aria-invalid={invalid || undefined}
                aria-describedby={hintId}
                className="block w-28 rounded-md border border-rule bg-page py-2 pl-3.5 pr-9 text-2xl font-medium tabular-nums text-ink placeholder:text-ink-3"
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-lg text-ink-3"
              >
                %
              </span>
            </span>

            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(sliderValue)}
              onChange={(event) => onChange(event.target.value)}
              aria-label={t("official_slider_aria", { label: providerLabel })}
              aria-valuetext={`${Math.round(sliderValue)}%`}
              className={`order-3 h-6 w-full min-w-0 cursor-pointer accent-ink transition-opacity sm:order-2 sm:w-auto sm:grow ${
                view.calibrated ? "" : "opacity-50 hover:opacity-100 focus-visible:opacity-100"
              }`}
            />

            {(raw !== "" || readOnly) && (
              <span className="order-2 ml-auto flex shrink-0 gap-2 sm:order-3 sm:ml-0">
                {raw !== "" && (
                  <button
                    type="button"
                    onClick={() => onChange("")}
                    className="rounded-md border border-rule px-3 py-1.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
                  >
                    {t("delete")}
                  </button>
                )}
                {readOnly && (
                  <button
                    type="button"
                    onClick={() => setCorrecting(false)}
                    className="rounded-md border border-rule px-3 py-1.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
                  >
                    {t("official_correct_done")}
                  </button>
                )}
              </span>
            )}
          </div>
        </div>
      )}

      <p id={hintId} className={`mt-4 flex max-w-3xl items-start gap-2 text-sm ${invalid ? "text-ink" : "text-ink-3"}`}>
        {invalid && <StopCircleIcon className="mt-0.5 shrink-0 text-critical" />}
        <span>{hint(props, correcting, t, locale)}</span>
      </p>
      {status.status === "failed" && status.problem && (
        <div className="mt-2">
          <StatusLine tone="problem">{t(`official_save_failed_${status.problem}`)}</StatusLine>
        </div>
      )}

      {props.belowField}
      {props.children}
    </section>
  );
}
