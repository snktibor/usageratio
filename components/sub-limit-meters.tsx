"use client";

import { useTranslations, useLocale } from "next-intl";

import { useId } from "react";
import { AlertTriangleIcon, CheckCircleIcon, InfoCircleIcon, StopCircleIcon } from "@/components/icons";
import { statusLabel } from "@/components/quota-meter";
import type { Entry } from "@/components/use-official-entry";
import type { DashboardModel } from "@/lib/dashboard";
import { formatCycleMoment, formatHeroPercent, formatPercent, formatTokens } from "@/lib/format";
import type { SubLimitView } from "@/lib/ground-truth";
import type { SubLimitModel } from "@/lib/sub-limits";

/** A sub-limit's field as typed, and how far the sub-limit is by it. */
export interface SubLimitState {
  entry: Entry;
  invalid: boolean;
  view: SubLimitView;
}

/** The slider's own colour carries the severity, next to the icon and the label below it. */
const STATUS_STYLE = {
  good: { accent: "accent-ink", icon: CheckCircleIcon, iconColor: "text-good" },
  warning: { accent: "accent-warning", icon: AlertTriangleIcon, iconColor: "text-warning" },
  critical: { accent: "accent-critical", icon: StopCircleIcon, iconColor: "text-critical" },
} as const;
const UNKNOWN_STYLE = { accent: "accent-ink", icon: InfoCircleIcon, iconColor: "text-ink-3" } as const;

interface RowProps {
  model: DashboardModel;
  state: SubLimitState;
  onChange: (raw: string) => void;
  providerLabel: string;
}

function modeNote(sub: SubLimitModel, t: ReturnType<typeof useTranslations>, locale: string): string {
  return sub.shareCap === null ? t("separate_quota") : t("max_share_of_quota", { share: formatPercent(sub.shareCap, locale) });
}

/** Where the figure comes from, and what it means for the provider's whole budget. */
function sourceNote(subView: SubLimitView, providerLabel: string, t: ReturnType<typeof useTranslations>, locale: string): string {
  const { sub, source, ofProvider } = subView;
  const measured = t("machines_measured", { tokens: formatTokens(sub.total, locale) });
  const ofWhole =
    ofProvider !== null && sub.shareCap !== null
      ? t("of_provider_with_cap", { label: providerLabel, ofWhole: formatPercent(ofProvider, locale), cap: formatPercent(sub.shareCap, locale) })
      : "";
  if (source === "official") return t("official_value_period", { ofWhole });
  if (source === "provider") {
    return t("from_official_by_measured", { label: providerLabel, ofWhole, measured });
  }
  // Measured: against its own token limit, or (a part) against the provider's.
  const limit = sub.quota ? t("from_token_limit", { tokens: formatTokens(sub.quota.limit, locale) }) : "";
  return sub.shareCap === null
    ? t("by_machine_measurement_limit", { limit, measured })
    : t("by_machine_measurement", { ofWhole, measured });
}

function paceNote(subView: SubLimitView, model: DashboardModel, t: ReturnType<typeof useTranslations>, locale: string): string {
  const quota = subView.quota!;
  if (quota.total >= 1 || quota.total === 0 || quota.pace.earlyBurn) return "";
  if (quota.pace.runOutAt !== null) {
    return t("runs_out_around", { moment: formatCycleMoment(quota.pace.runOutAt, model.period, model.timeZone, locale) });
  }
  if (quota.pace.projectedTotal !== null) {
    return t("projected_reset", { projected: formatPercent(quota.pace.projectedTotal, locale) });
  }
  return "";
}

/** Its own reading and the provider's disagree past the tolerance: which is likely mistyped. */
function mismatchNote(subView: SubLimitView, providerLabel: string, t: ReturnType<typeof useTranslations>, locale: string): string {
  return t("sublimit_mismatch", {
    name: subView.sub.name,
    share: formatPercent(subView.ofProvider!, locale),
    label: providerLabel,
    total: formatPercent(subView.providerUsedFraction!, locale),
  });
}

/** Nothing tells how far it is yet: what would. */
function unknownNote(subView: SubLimitView, providerLabel: string, t: ReturnType<typeof useTranslations>, locale: string): string {
  const { sub } = subView;
  if (!sub.hasSplit) {
    return t("no_model_breakdown_sublimit", { name: sub.name });
  }
  if (sub.shareCap !== null) {
    return t("enter_sublimit_or_provider", { name: sub.name, label: providerLabel });
  }
  return t("enter_sublimit_percentage", { name: sub.name, label: providerLabel });
}

/**
 * One sub-limit: a smaller twin of the official-usage field above it, with
 * its own entry, and a line on how it stands.
 */
function SubLimitRow({ model, state, onChange: setEntry, providerLabel }: RowProps) {
    const locale = useLocale();
  const t = useTranslations("Widgets");
  const { entry, invalid, view: subView } = state;
  const { sub } = subView;
  const fieldId = useId();
  const hintId = useId();

  const { quota } = subView;
  const style = quota ? STATUS_STYLE[quota.status] : UNKNOWN_STYLE;
  const StatusIcon = invalid ? StopCircleIcon : style.icon;
  // Left alone, the slider rests on what is known of it: dragging starts from there.
  const sliderValue = Math.round(Math.min(1, quota?.usedFraction ?? 0) * 100);

  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="w-full sm:w-44 sm:shrink-0">
          <label htmlFor={fieldId} className="font-medium">
            {sub.name}
          </label>
          <span className="ml-2 text-sm text-ink-3 sm:ml-0 sm:block">{modeNote(sub, t, locale)}</span>
        </div>

        <div className="flex min-w-56 grow flex-wrap items-center gap-3 sm:flex-nowrap">
          <span className="relative shrink-0">
            <input
              id={fieldId}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              maxLength={7}
              placeholder="–"
              value={entry.raw}
              onChange={(event) => setEntry(event.target.value)}
              aria-invalid={invalid || undefined}
              aria-describedby={hintId}
              className="block w-24 rounded-md border border-rule bg-page py-1.5 pl-3 pr-8 text-lg font-medium tabular-nums text-ink placeholder:text-ink-3"
            />
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ink-3">
              %
            </span>
          </span>

          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={sliderValue}
            onChange={(event) => setEntry(event.target.value)}
            aria-label={t("sublimit_slider_aria", { name: sub.name })}
            aria-valuetext={`${sliderValue}%`}
            className={`order-3 h-5 w-full min-w-0 cursor-pointer transition-opacity sm:order-2 sm:w-auto sm:grow ${style.accent} ${
              subView.source === "official" ? "" : "opacity-50 hover:opacity-100 focus-visible:opacity-100"
            }`}
          />

          {entry.raw !== "" && (
            <button
              type="button"
              onClick={() => setEntry("")}
              className="order-2 ml-auto shrink-0 rounded-md border border-rule px-2.5 py-1 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink sm:order-3 sm:ml-0"
            >
              {t("delete")}
            </button>
          )}
        </div>
      </div>

      <p id={hintId} className={`mt-2 flex max-w-3xl items-start gap-2 text-sm ${invalid ? "text-ink" : "text-ink-3"}`}>
        <StatusIcon className={`mt-0.5 shrink-0 ${invalid ? "text-critical" : style.iconColor}`} />
        {invalid ? (
          <span>{t("number_between_0_100")}</span>
        ) : quota ? (
          <span>
            <strong className="font-medium text-ink">
              {formatHeroPercent(quota.usedFraction, locale)} {t("consumed")} {statusLabel(quota, t, locale)}
            </strong>
            {paceNote(subView, model, t, locale)} {sourceNote(subView, providerLabel, t, locale)}
          </span>
        ) : (
          <span>{unknownNote(subView, providerLabel, t, locale)}</span>
        )}
      </p>
      {subView.mismatched && (
        <p className="mt-2 flex max-w-3xl items-start gap-2 text-sm text-ink">
          <StopCircleIcon className="mt-0.5 shrink-0 text-critical" />
          <span>{mismatchNote(subView, providerLabel, t, locale)}</span>
        </p>
      )}
    </li>
  );
}

/** The provider's sub-limits under its official-usage field; nothing while it has none. */
export function SubLimitMeters({
  model,
  subLimits,
  onChange,
  providerLabel,
}: {
  model: DashboardModel;
  subLimits: SubLimitState[];
  onChange: (subLimitId: string, raw: string) => void;
  providerLabel: string;
}) {
    const locale = useLocale();
  const t = useTranslations("Widgets");
  if (subLimits.length === 0) return null;
  const hasSeparate = model.subLimits.some((sub) => sub.shareCap === null);

  return (
    <div className="mt-5 border-t border-hairline pt-5">
      <h3 className="text-sm text-ink-3">{t("sublimits_title")}</h3>
      <ul className="mt-3 space-y-5">
        {subLimits.map((state) => (
          <SubLimitRow
            key={state.view.sub.id}
            model={model}
            state={state}
            onChange={(raw) => onChange(state.view.sub.id, raw)}
            providerLabel={providerLabel}
          />
        ))}
      </ul>
      {hasSeparate && (
        <p className="mt-4 max-w-3xl text-sm text-ink-3">
          {t("separate_sublimits_explanation_1", { label: providerLabel })}
          {t("separate_sublimits_explanation_2")}
        </p>
      )}
    </div>
  );
}
