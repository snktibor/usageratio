import { AlertTriangleIcon, CheckCircleIcon, StopCircleIcon } from "@/components/icons";
import type { DashboardModel } from "@/lib/dashboard";
import {
  formatDateTime,
  formatDuration,
  formatHeroPercent,
  formatPercent,
  formatTokens,
  formatWeekdayTime,
  periodAdjective,
  weekdayShort,
} from "@/lib/format";
import type { DashboardView } from "@/lib/ground-truth";

type Segment = DashboardModel["cycle"]["segments"][number];

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

function statusLabel({ quota }: DashboardView): string {
  if (quota.status === "critical") return "A keret elfogyott.";
  if (quota.pace.earlyBurn) return "Erős kezdés.";
  if (quota.status === "warning") {
    return quota.pace.runOutAt !== null ? "Túl gyors a tempó." : "Fogytán a keret.";
  }
  if (quota.total === 0) return "Még nincs fogyasztás.";
  // No projection yet: say so instead of calling the pace fine.
  if (quota.pace.projectedTotal === null) return "A ciklus elején jársz.";
  return "A tempó rendben.";
}

/** A moment inside the cycle: a weekday pins it down in a week, only a date does in a month. */
function formatMoment(ms: number, model: DashboardModel): string {
  return model.period === "monthly"
    ? formatDateTime(ms, model.timeZone)
    : formatWeekdayTime(ms, model.timeZone);
}

function paceSentence(model: DashboardModel, { quota }: DashboardView): string {
  const { total, limit, pace } = quota;
  if (total >= limit) {
    // With the remaining tokens switched off, the overage (tokens left, below zero) stays unsaid too.
    if (!model.showRemaining) {
      return `A következő reset ${formatDuration(model.cycle.endMs - model.generatedAt)} múlva indít új keretet.`;
    }
    return quota.overage > 0
      ? `A túllépés ${formatTokens(quota.overage)} token.`
      : "A resetig nem maradt több token.";
  }
  if (total === 0) return `A teljes ${periodAdjective(model.period)} keret rendelkezésre áll.`;
  if (pace.earlyBurn) {
    return (
      `A ciklus első napján már a keret ${formatPercent(quota.usedFraction)}-a elfogyott, ` +
      `az arányos napi rész ${formatPercent(pace.dailyShare)}.`
    );
  }
  if (pace.projectedTotal === null) return "A tempó megbecsléséhez legalább egy napnyi adat kell.";
  if (pace.runOutAt !== null) {
    return (
      `Ilyen ütemben a keret ${formatMoment(pace.runOutAt, model)} körül fogy el, ` +
      `${formatDuration(model.cycle.endMs - pace.runOutAt)} a reset előtt.`
    );
  }
  return `Ilyen ütemben a resetig a keret kb. ${formatPercent(pace.projectedTotal / limit)}-a fogy el.`;
}

/**
 * The text under one day of the ruler. A week names every day that has the
 * room. A month does not have it: today, the 1st and every fifth day are
 * named, minus the ones that would run into today's.
 */
function rulerLabel(model: DashboardModel, segment: Segment, index: number, todayIndex: number): string | null {
  const width = segment.endFraction - segment.startFraction;
  if (model.period === "weekly") return width >= 0.07 ? weekdayShort(segment.weekday) : null;

  if (width < 0.02) return null;
  const isLandmark = segment.monthDay === 1 || segment.monthDay % 5 === 0;
  const named = index === todayIndex || (isLandmark && Math.abs(index - todayIndex) !== 1);
  return named ? `${segment.monthDay}.` : null;
}

/**
 * The page's one gauge: usage against the limit, laid over the cycle itself.
 * Fill ahead of the "most" marker means burning faster than time passes.
 */
export function QuotaMeter({ model, view }: { model: DashboardModel; view: DashboardView }) {
  const { quota } = view;
  const style = STATUS_STYLE[quota.status];
  const StatusIcon = style.icon;
  const period = periodAdjective(model.period);
  const fillPercent = Math.min(1, quota.usedFraction) * 100;
  const nowFraction = model.cycle.elapsedFraction;
  const nowAlign =
    nowFraction < 0.05 ? "translate-x-0" : nowFraction > 0.95 ? "-translate-x-full" : "-translate-x-1/2";
  const elapsedNote = `a ciklus ${formatPercent(nowFraction)}-a telt el`;
  const todayIndex = model.cycle.segments.findIndex(
    (segment) => nowFraction >= segment.startFraction && nowFraction < segment.endFraction,
  );

  return (
    <section aria-labelledby="quota-heading">
      <h1 id="quota-heading" className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <span className="hero-figure">{formatHeroPercent(quota.usedFraction)}</span>
        <span className="text-xl text-ink-2 sm:text-2xl">elfogyott a {period} keretből</span>
        {view.calibrated && (
          <span className="rounded-full border border-ink-3 px-3 py-1 text-sm text-ink-2">
            hivatalos érték
          </span>
        )}
      </h1>

      <div className="relative mt-12">
        <span
          aria-hidden="true"
          className={`absolute -top-7 text-xs text-ink-2 ${nowAlign}`}
          style={{ left: `${nowFraction * 100}%` }}
        >
          most
        </span>

        <div
          role="meter"
          aria-label={model.period === "monthly" ? "Havi tokenkeret" : "Heti tokenkeret"}
          aria-valuemin={0}
          aria-valuemax={quota.limit}
          aria-valuenow={Math.round(Math.min(quota.total, quota.limit))}
          aria-valuetext={`${formatTokens(quota.total)} / ${formatTokens(quota.limit)} token, ${formatHeroPercent(quota.usedFraction)}`}
          className={`relative h-5 w-full rounded-r-[4px] transition-colors duration-500 ${style.track}`}
        >
          <div
            className={`meter-fill h-full w-full ${style.fill}`}
            style={{ clipPath: `inset(0 ${100 - fillPercent}% 0 0 round 0 4px 4px 0)` }}
          />
        </div>

        {/* Where the cycle stands. The page-coloured ring keeps it legible over the fill. */}
        <div
          aria-hidden="true"
          className="absolute -top-1.5 h-8 w-0.5 -translate-x-1/2 bg-ink shadow-[0_0_0_2px_var(--color-page)]"
          style={{ left: `${nowFraction * 100}%` }}
        />

        <div aria-hidden="true" className="relative mt-2 h-7">
          {model.cycle.segments.map((segment, index) => {
            const label = rulerLabel(model, segment, index, todayIndex);
            return (
              <div
                key={segment.startFraction}
                className="absolute top-0 h-full"
                style={{
                  left: `${segment.startFraction * 100}%`,
                  width: `${(segment.endFraction - segment.startFraction) * 100}%`,
                }}
              >
                {index > 0 && <span className="absolute left-0 top-0 h-2 w-px bg-rule" />}
                {label && (
                  <span
                    className={`absolute left-1/2 top-2.5 -translate-x-1/2 whitespace-nowrap text-xs ${index === todayIndex ? "text-ink" : "text-ink-3"}`}
                  >
                    {label}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-6 flex max-w-2xl items-start gap-2.5 text-base text-ink-2">
        <StatusIcon className={`mt-1 shrink-0 ${style.iconColor}`} />
        <span>
          <strong className="font-medium text-ink">{statusLabel(view)}</strong> {paceSentence(model, view)}
        </span>
      </p>

      <dl
        className={`mt-8 grid grid-cols-1 gap-x-10 gap-y-5 border-t border-hairline pt-6 ${
          model.showRemaining ? "sm:grid-cols-3" : "sm:grid-cols-2"
        }`}
      >
        <div>
          <dt className="text-sm text-ink-3">Elfogyott</dt>
          <dd className="mt-1 text-2xl font-medium">{formatTokens(quota.total)} token</dd>
          <dd className="text-sm text-ink-3">
            a {period} {formatTokens(quota.limit)} tokenből
          </dd>
        </div>
        {model.showRemaining && (
          <div>
            <dt className="text-sm text-ink-3">{quota.overage > 0 ? "Túllépés" : "Maradt"}</dt>
            <dd className="mt-1 text-2xl font-medium">
              {formatTokens(quota.overage > 0 ? quota.overage : quota.remaining)} token
            </dd>
            <dd className="text-sm text-ink-3">{elapsedNote}</dd>
          </div>
        )}
        <div>
          <dt className="text-sm text-ink-3">Reset</dt>
          <dd className="mt-1 text-2xl font-medium">
            {formatDuration(model.cycle.endMs - model.generatedAt)} múlva
          </dd>
          <dd className="text-sm text-ink-3">
            {formatMoment(model.cycle.endMs, model)}
            {/* How far the cycle is belongs to neither figure: it moves here when its block is off. */}
            {!model.showRemaining && <> · {elapsedNote}</>}
          </dd>
        </div>
      </dl>
    </section>
  );
}
