import { useLocale, useTranslations } from "next-intl";
import { CheckCircleIcon, ClockIcon, StopCircleIcon } from "@/components/icons";
import { type FiveHourReading, fiveHourView } from "@/lib/five-hour";
import { formatClock, formatDuration, formatHeroPercent, formatPercent, formatRecentMoment } from "@/lib/format";

/** A reading older than this says when it was taken: the window may have moved on since. */
const STALE_MS = 15 * 60_000;

/** The weekly meter's levels: the fill turns amber from 80% and red at the limit. */
function fillClass(usedFraction: number): string {
  if (usedFraction >= 1) return "bg-critical";
  if (usedFraction >= 0.8) return "bg-warning";
  return "bg-ink";
}

/** Where a label under a marker sits: from it in the first half, up to it after. */
function alignAt(fraction: number): string {
  return fraction <= 0.5 ? "" : "-translate-x-full";
}

/**
 * The provider's own 5-hour window under the weekly figure, smaller: what is
 * used beside its title, when it resets across from it, a bar with the time
 * gone by under its marker and the time left at its end, a purple mark where
 * the window's pace runs out, and one line of outlook (lib/five-hour.ts).
 */
export function FiveHourMeter({
  reading,
  generatedAt,
  timeZone,
}: {
  reading: FiveHourReading;
  generatedAt: number;
  timeZone: string;
}) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const view = fiveHourView(reading, generatedAt);
  const clock = (ms: number) => formatClock(ms, timeZone, locale);
  const running = view.resetsAtMs !== null;
  const elapsed = view.elapsedFraction;
  const fillPercent = Math.min(1, view.usedFraction) * 100;
  const stale = generatedAt - view.observedAtMs > STALE_MS;
  const timeLeft =
    view.resetsAtMs === null
      ? null
      : t("five_hour_left", { duration: formatDuration(view.resetsAtMs - generatedAt, locale) });

  const { outlook } = view;
  const outlookText =
    outlook.kind === "runs_out"
      ? t("five_hour_runs_out", { time: clock(outlook.atMs) })
      : outlook.kind === "lasts"
        ? t("five_hour_lasts")
        : outlook.kind === "used_up"
          ? t("five_hour_used_up")
          : outlook.kind === "too_early"
            ? t("five_hour_too_early")
            : t("five_hour_idle");

  return (
    <section aria-labelledby="five-hour-heading" className="border-t border-hairline pt-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="five-hour-heading" className="flex items-baseline gap-3">
          <span className="text-sm tracking-wider text-ink-3 uppercase">{t("five_hour_heading")}</span>
          <span className="font-semibold text-ink tabular-nums">{formatHeroPercent(view.usedFraction, locale)}</span>
        </h2>
        {view.resetsAtMs !== null && (
          <p className="text-sm text-ink-3 tabular-nums">
            <span className="sr-only">{t("five_hour_resets_at")} </span>
            {clock(view.resetsAtMs)}
          </p>
        )}
      </div>

      <div className="relative mt-3">
        <div
          role="meter"
          aria-label={t("five_hour_heading")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fillPercent * 10) / 10}
          aria-valuetext={formatHeroPercent(view.usedFraction, locale)}
          className="h-2 w-full overflow-hidden rounded-full bg-rule"
        >
          <div className={`h-full rounded-full ${fillClass(view.usedFraction)}`} style={{ width: `${fillPercent}%` }} />
        </div>
        {running && (
          <div
            aria-hidden="true"
            className="absolute -top-1 h-4 w-0.5 -translate-x-1/2 bg-ink shadow-[0_0_0_2px_var(--color-page)]"
            style={{ left: `${elapsed * 100}%` }}
          />
        )}
        {view.runOutFraction !== null && (
          <div
            aria-hidden="true"
            className="absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-run-out"
            style={{ left: `${view.runOutFraction * 100}%` }}
          />
        )}
      </div>

      {running && view.resetsAtMs !== null && (
        <div className="relative mt-1.5 h-5 text-sm text-ink-3 tabular-nums">
          <span className={`absolute whitespace-nowrap ${alignAt(elapsed)}`} style={{ left: `${elapsed * 100}%` }}>
            <span className="sr-only">{t("five_hour_elapsed")} </span>
            {elapsed <= 0.5 ? (
              <>
                <span aria-hidden="true">▲ </span>
                {formatPercent(elapsed, locale)}
              </>
            ) : (
              <>
                {formatPercent(elapsed, locale)}
                <span aria-hidden="true"> ▲</span>
              </>
            )}
          </span>
          {/* Late in the window the marker's label takes the right end: the time left moves to the left. */}
          <span className={`absolute hidden whitespace-nowrap sm:block ${elapsed > 0.65 ? "left-0" : "right-0"}`}>
            {timeLeft}
          </span>
        </div>
      )}
      {/* A phone has no room for both under the bar: the time left takes a line of its own. */}
      {timeLeft && <p className="text-right text-sm text-ink-3 tabular-nums sm:hidden">{timeLeft}</p>}

      <p className="mt-3 flex items-center gap-2.5 text-sm text-ink-2">
        {outlook.kind === "runs_out" ? (
          <span aria-hidden="true" className="h-3.5 w-0.5 shrink-0 rounded-full bg-run-out" />
        ) : outlook.kind === "used_up" ? (
          <StopCircleIcon className="shrink-0 text-critical" />
        ) : outlook.kind === "lasts" ? (
          <CheckCircleIcon className="shrink-0 text-good" />
        ) : (
          <ClockIcon className="shrink-0 text-ink-3" />
        )}
        <span>
          {outlookText}
          {stale && (
            <span className="text-ink-3">
              {" "}
              ·{" "}
              {t("five_hour_read_at", {
                time: formatRecentMoment(view.observedAtMs, generatedAt, timeZone, locale),
              })}
            </span>
          )}
        </span>
      </p>
    </section>
  );
}
