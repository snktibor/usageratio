import { useLocale, useTranslations } from "next-intl";
import { CycleRuler } from "@/components/cycle-ruler";
import { AlertTriangleIcon, CheckCircleIcon, InfoCircleIcon, StopCircleIcon } from "@/components/icons";
import { InfoTip } from "@/components/info-tip";
import type { DashboardModel } from "@/lib/dashboard";
import {
  formatCost,
  formatCycleMoment,
  formatDateTime,
  formatDuration,
  formatEnergy,
  formatFactor,
  formatHeroPercent,
  formatPercent,
  formatRecentMoment,
  formatTokens,
  formatWater,
} from "@/lib/format";
import type { DashboardView } from "@/lib/ground-truth";
import type { Translator } from "@/lib/i18n";
import type { QuotaAssessment } from "@/lib/quota";
import { type RecentPace, recentPace } from "@/lib/recent-pace";

const HOUR = 3_600_000;

/** Fill carries severity; the track is a dimmer step of the same colour. */
const STATUS_STYLE = {
  good: { fill: "bg-ink", track: "bg-rule", icon: CheckCircleIcon, iconColor: "text-good" },
  warning: {
    fill: "bg-warning",
    track: "bg-warning/20",
    icon: AlertTriangleIcon,
    iconColor: "text-warning",
  },
  critical: {
    fill: "bg-critical",
    track: "bg-critical/25",
    icon: StopCircleIcon,
    iconColor: "text-critical",
  },
} as const;

/** No token limit and no official reading: nothing tells how much of the budget is gone. */
const UNKNOWN_STYLE = { fill: "bg-ink", track: "bg-rule", icon: InfoCircleIcon, iconColor: "text-ink-3" } as const;

export function statusLabel(quota: QuotaAssessment, t: Translator<"Widgets">): string {
  if (quota.status === "critical") return t("pace_running_out");
  if (quota.pace.earlyBurn) return t("pace_early_burn");
  if (quota.status === "warning") {
    return quota.pace.runOutAt !== null ? t("pace_too_fast") : t("pace_running_out");
  }
  if (quota.total === 0) return t("pace_no_usage");
  // No projection yet: say so instead of calling the pace fine.
  if (quota.pace.projectedTotal === null) return t("pace_early_cycle");
  return t("pace_ok");
}

function formatMoment(ms: number, model: DashboardModel, locale: string): string {
  return formatCycleMoment(ms, model.period, model.timeZone, locale);
}

function paceSentence(
  model: DashboardModel,
  view: DashboardView,
  quota: QuotaAssessment,
  t: Translator<"Widgets">,
  locale: string,
): string {
  const { total, limit, pace } = quota;
  if (total >= limit) {
    // With the remaining tokens switched off, the overage (tokens left, below zero) stays unsaid too.
    // Without a token limit there are no tokens to state at all.
    if (!view.inTokens || !model.showRemaining) {
      return t("next_reset_in", { duration: formatDuration(model.cycle.endMs - model.generatedAt, locale) });
    }
    return quota.overage > 0
      ? t("overage_amount", { tokens: formatTokens(quota.overage, locale) })
      : t("no_tokens_left");
  }
  if (total === 0) {
    return t("full_quota_available", { period: model.period });
  }
  if (pace.earlyBurn) {
    return t("first_day_burn", {
      used: formatPercent(quota.usedFraction, locale),
      daily: formatPercent(pace.dailyShare, locale),
    });
  }
  if (pace.projectedTotal === null) return t("need_one_day_for_pace");
  if (pace.runOutAt !== null) {
    return t("run_out_estimation", {
      moment: formatMoment(pace.runOutAt, model, locale),
      duration: formatDuration(model.cycle.endMs - pace.runOutAt, locale),
    });
  }
  return t("projected_total", { projected: formatPercent(pace.projectedTotal / limit, locale) });
}

/** The last hours' pace next to the average: from when, how much faster or slower, and how long it lasts. */
function recentPaceSentence(
  model: DashboardModel,
  recent: RecentPace,
  t: Translator<"Widgets">,
  locale: string,
): string {
  const window = recent.changed
    ? t("recent_pace_since", { time: formatRecentMoment(recent.sinceMs, model.generatedAt, model.timeZone, locale) })
    : t("recent_pace_last_hours", { hours: Math.round((recent.untilMs - recent.sinceMs) / HOUR) });
  if (recent.ratio === 0) return t("recent_pace_idle", { window });
  const ratio = formatFactor(recent.ratio, locale);
  if (recent.runOutAt === null) return t("recent_pace_lasts", { window, ratio });
  return t("recent_pace_runs_out", {
    window,
    ratio,
    duration: formatDuration(recent.runOutAt - model.generatedAt, locale),
    moment: formatMoment(recent.runOutAt, model, locale),
  });
}

function meterAttributes(
  model: DashboardModel,
  quota: QuotaAssessment | null,
  tokenQuota: QuotaAssessment | null,
  t: Translator<"Widgets">,
  locale: string,
): React.HTMLAttributes<HTMLDivElement> {
  if (!quota) return { "aria-hidden": true };
  const label = model.period === "monthly" ? t("monthly_adjective") : t("weekly_adjective");
  if (tokenQuota) {
    return {
      role: "meter",
      "aria-label": t("aria_token_quota", { label }),
      "aria-valuemin": 0,
      "aria-valuemax": tokenQuota.limit,
      "aria-valuenow": Math.round(Math.min(tokenQuota.total, tokenQuota.limit)),
      "aria-valuetext": t("aria_token_valuetext", {
        total: formatTokens(tokenQuota.total, locale),
        limit: formatTokens(tokenQuota.limit, locale),
        percent: formatHeroPercent(tokenQuota.usedFraction, locale),
      }),
    };
  }
  return {
    role: "meter",
    "aria-label": t("aria_quota", { label }),
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    "aria-valuenow": Math.round(Math.min(1, quota.usedFraction) * 1000) / 10,
    "aria-valuetext": t("aria_official_value", { percent: formatHeroPercent(quota.usedFraction, locale) }),
  };
}

/**
 * The page's one gauge: usage against the limit, laid over the cycle itself.
 * Fill ahead of the "most" marker means burning faster than time passes.
 * Without a token limit only an official reading fills it.
 */
export function QuotaMeter({ model, view }: { model: DashboardModel; view: DashboardView }) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const { quota } = view;
  // Token amounts mean tokens only against a limit: without one `quota` counts fractions of the budget.
  const tokenQuota = view.inTokens ? quota : null;
  // A finished cycle has nothing left to spend, nor a pace to keep: only what it came to.
  const { closed } = model;
  const showRemaining = tokenQuota !== null && model.showRemaining && !closed;
  const style = quota ? STATUS_STYLE[quota.status] : UNKNOWN_STYLE;
  const StatusIcon = style.icon;
  const fillPercent = quota ? Math.min(1, quota.usedFraction) * 100 : 0;
  const nowFraction = model.cycle.elapsedFraction;
  const nowAlign = nowFraction < 0.05 ? "translate-x-0" : nowFraction > 0.95 ? "-translate-x-full" : "-translate-x-1/2";
  const elapsedNote = t("cycle_elapsed", { percent: formatPercent(nowFraction, locale) });
  const recent = closed ? null : recentPace(model, view);

  return (
    <section aria-labelledby="quota-heading">
      <h1 id="quota-heading" className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        {quota ? (
          <>
            <span className="hero-figure">{formatHeroPercent(quota.usedFraction, locale)}</span>
            <span className="text-xl text-ink-2 sm:text-2xl">{t("quota_consumed", { period: model.period })}</span>
          </>
        ) : (
          <>
            <span aria-hidden="true" className="hero-figure text-ink-3">
              –%
            </span>
            <span className="text-xl text-ink-2 sm:text-2xl">
              {closed ? t("no_official_value") : t("no_official_value_yet")}
            </span>
          </>
        )}
        {view.calibrated && (
          <span className="rounded-full border border-ink-3 px-3 py-1 text-sm text-ink-2">{t("official_value")}</span>
        )}
      </h1>

      {model.cost && (
        <p className="relative mt-2 flex items-center gap-1.5 text-sm text-ink-3">
          {/* Each figure stays whole on a narrow screen: the line only breaks between them. */}
          <span>
            {t("cost_estimate", { amount: formatCost(model.cost.total, locale) })}
            {model.cost.resources && (
              <>
                {" · "}
                <span className="whitespace-nowrap">
                  {t("resource_energy", { energy: formatEnergy(model.cost.resources.energyKwh, locale) })}
                </span>
                {" · "}
                <span className="whitespace-nowrap">
                  {t("resource_water", { water: formatWater(model.cost.resources.waterLitres, locale) })}
                </span>
              </>
            )}
          </span>
          <InfoTip label={t("cost_estimate_tooltip_aria")}>
            <span className="block">{t("cost_estimate_tooltip")}</span>
            {model.cost.resources && <span className="mt-2 block">{t("resource_estimate_tooltip")}</span>}
          </InfoTip>
        </p>
      )}

      <div className="relative mt-12">
        {!closed && (
          <span
            aria-hidden="true"
            className={`absolute -top-7 text-xs text-ink-2 ${nowAlign}`}
            style={{ left: `${nowFraction * 100}%` }}
          >
            {t("now")}
          </span>
        )}

        <div
          {...meterAttributes(model, quota, tokenQuota, t, locale)}
          className={`relative h-5 w-full rounded-r-[4px] transition-colors duration-500 ${style.track}`}
        >
          <div
            className={`meter-fill h-full w-full ${style.fill}`}
            style={{ clipPath: `inset(0 ${100 - fillPercent}% 0 0 round 0 4px 4px 0)` }}
          />
        </div>

        {/* Where the cycle stands. The page-coloured ring keeps it legible over the fill. */}
        {!closed && (
          <div
            aria-hidden="true"
            className="absolute -top-1.5 h-8 w-0.5 -translate-x-1/2 bg-ink shadow-[0_0_0_2px_var(--color-page)]"
            style={{ left: `${nowFraction * 100}%` }}
          />
        )}

        <CycleRuler model={model} />
      </div>

      <p className="mt-6 flex max-w-2xl items-start gap-2.5 text-base text-ink-2">
        <StatusIcon className={`mt-1 shrink-0 ${style.iconColor}`} />
        {closed ? (
          <span>
            <strong className="font-medium text-ink">{t("cycle_closed")}</strong>{" "}
            {quota
              ? t("cycle_closed_used", { percent: formatHeroPercent(quota.usedFraction, locale) })
              : t("cycle_closed_unknown")}
          </span>
        ) : quota ? (
          <span>
            <strong className="font-medium text-ink">{statusLabel(quota, t)}</strong>{" "}
            {paceSentence(model, view, quota, t, locale)}
            {recent && ` ${recentPaceSentence(model, recent, t, locale)}`}
          </span>
        ) : (
          <span>
            {t.rich("quota_state_from_official", {
              strong: (chunks) => <strong className="font-medium text-ink">{chunks}</strong>,
            })}
          </span>
        )}
      </p>

      <dl
        className={`mt-8 grid grid-cols-1 gap-x-10 gap-y-5 border-t border-hairline pt-6 ${
          showRemaining ? "sm:grid-cols-3" : "sm:grid-cols-2"
        }`}
      >
        {tokenQuota ? (
          <div>
            <dt className="text-sm text-ink-3">{t("consumed")}</dt>
            <dd className="mt-1 text-2xl font-medium">
              {t("token_count", { count: formatTokens(tokenQuota.total, locale) })}
            </dd>
            <dd className="text-sm text-ink-3">
              {t("of_token_limit", { period: model.period, tokens: formatTokens(tokenQuota.limit, locale) })}
            </dd>
          </div>
        ) : (
          <div>
            <dt className="text-sm text-ink-3">{t("measured_usage")}</dt>
            <dd className="mt-1 text-2xl font-medium">
              {t("token_count", { count: formatTokens(view.measured.total, locale) })}
            </dd>
            <dd className="text-sm text-ink-3">{t("according_to_machines")}</dd>
          </div>
        )}
        {showRemaining && tokenQuota && (
          <div>
            <dt className="text-sm text-ink-3">{tokenQuota.overage > 0 ? t("overage") : t("remaining")}</dt>
            <dd className="mt-1 text-2xl font-medium">
              {t("token_count", {
                count: formatTokens(tokenQuota.overage > 0 ? tokenQuota.overage : tokenQuota.remaining, locale),
              })}
            </dd>
            <dd className="text-sm text-ink-3">{elapsedNote}</dd>
          </div>
        )}
        {closed ? (
          <div>
            <dt className="text-sm text-ink-3">{t("cycle_span")}</dt>
            {/* A date, not a weekday: the week in question is not this one. */}
            <dd className="mt-1 text-2xl font-medium">{formatDateTime(model.cycle.endMs, model.timeZone, locale)}</dd>
            <dd className="text-sm text-ink-3">
              {t("cycle_started", { moment: formatDateTime(model.cycle.startMs, model.timeZone, locale) })}
            </dd>
          </div>
        ) : (
          <div>
            <dt className="text-sm text-ink-3">{t("reset")}</dt>
            <dd className="mt-1 text-2xl font-medium">
              {t("time_left", { duration: formatDuration(model.cycle.endMs - model.generatedAt, locale) })}
            </dd>
            <dd className="text-sm text-ink-3">
              {formatMoment(model.cycle.endMs, model, locale)}
              {/* How far the cycle is belongs to neither figure: it moves here when its block is off. */}
              {!showRemaining && <> · {elapsedNote}</>}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
