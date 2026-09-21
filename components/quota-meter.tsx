import { AlertTriangleIcon, CheckCircleIcon, StopCircleIcon } from "@/components/icons";
import type { DashboardModel } from "@/lib/dashboard";
import {
  formatDuration,
  formatHeroPercent,
  formatPercent,
  formatTokens,
  formatWeekdayTime,
  weekdayShort,
} from "@/lib/format";

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

function statusLabel(model: DashboardModel): string {
  if (model.status === "critical") return "A keret elfogyott.";
  if (model.pace.earlyBurn) return "Erős kezdés.";
  if (model.status === "warning") {
    return model.pace.runOutAt !== null ? "Túl gyors a tempó." : "Fogytán a keret.";
  }
  if (model.total === 0) return "Még nincs fogyasztás.";
  // No projection yet: say so instead of calling the pace fine.
  if (model.pace.projectedTotal === null) return "A ciklus elején jársz.";
  return "A tempó rendben.";
}

function paceSentence(model: DashboardModel): string {
  const { total, limit, pace, cycle, timeZone } = model;
  if (total >= limit) {
    return model.overage > 0
      ? `A túllépés ${formatTokens(model.overage)} token.`
      : "A resetig nem maradt több token.";
  }
  if (total === 0) return "A teljes heti keret rendelkezésre áll.";
  if (pace.earlyBurn) {
    return (
      `A ciklus első napján már a keret ${formatPercent(model.usedFraction)}-a elfogyott, ` +
      `az arányos napi rész ${formatPercent(pace.dailyShare)}.`
    );
  }
  if (pace.projectedTotal === null) return "A tempó megbecsléséhez legalább egy napnyi adat kell.";
  if (pace.runOutAt !== null) {
    return (
      `Ilyen ütemben a keret ${formatWeekdayTime(pace.runOutAt, timeZone)} körül fogy el, ` +
      `${formatDuration(cycle.endMs - pace.runOutAt)} a reset előtt.`
    );
  }
  return `Ilyen ütemben a resetig a keret kb. ${formatPercent(pace.projectedTotal / limit)}-a fogy el.`;
}

/**
 * The page's one gauge: usage against the weekly limit, laid over the week
 * itself. Fill ahead of the "most" marker means burning faster than time passes.
 */
export function QuotaMeter({ model }: { model: DashboardModel }) {
  const style = STATUS_STYLE[model.status];
  const StatusIcon = style.icon;
  const fillPercent = Math.min(1, model.usedFraction) * 100;
  const nowFraction = model.cycle.elapsedFraction;
  const nowAlign =
    nowFraction < 0.05 ? "translate-x-0" : nowFraction > 0.95 ? "-translate-x-full" : "-translate-x-1/2";

  return (
    <section aria-labelledby="quota-heading">
      <h1 id="quota-heading" className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <span className="hero-figure">{formatHeroPercent(model.usedFraction)}</span>
        <span className="text-xl text-ink-2 sm:text-2xl">elfogyott a heti keretből</span>
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
          aria-label="Heti tokenkeret"
          aria-valuemin={0}
          aria-valuemax={model.limit}
          aria-valuenow={Math.min(model.total, model.limit)}
          aria-valuetext={`${formatTokens(model.total)} / ${formatTokens(model.limit)} token, ${formatHeroPercent(model.usedFraction)}`}
          className={`relative h-5 w-full rounded-r-[4px] ${style.track}`}
        >
          <div
            className={`meter-fill h-full w-full ${style.fill}`}
            style={{ clipPath: `inset(0 ${100 - fillPercent}% 0 0 round 0 4px 4px 0)` }}
          />
        </div>

        {/* Where the week stands. The page-coloured ring keeps it legible over the fill. */}
        <div
          aria-hidden="true"
          className="absolute -top-1.5 h-8 w-0.5 -translate-x-1/2 bg-ink shadow-[0_0_0_2px_var(--color-page)]"
          style={{ left: `${nowFraction * 100}%` }}
        />

        <div aria-hidden="true" className="relative mt-2 h-7">
          {model.cycle.segments.map((segment, index) => {
            const width = segment.endFraction - segment.startFraction;
            const isToday = nowFraction >= segment.startFraction && nowFraction < segment.endFraction;
            return (
              <div
                key={segment.startFraction}
                className="absolute top-0 h-full"
                style={{ left: `${segment.startFraction * 100}%`, width: `${width * 100}%` }}
              >
                {index > 0 && <span className="absolute left-0 top-0 h-2 w-px bg-rule" />}
                {width >= 0.07 && (
                  <span
                    className={`absolute inset-x-0 top-2.5 text-center text-xs ${isToday ? "text-ink" : "text-ink-3"}`}
                  >
                    {weekdayShort(segment.weekday)}
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
          <strong className="font-medium text-ink">{statusLabel(model)}</strong> {paceSentence(model)}
        </span>
      </p>

      <dl className="mt-8 grid grid-cols-1 gap-x-10 gap-y-5 border-t border-hairline pt-6 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-ink-3">Elfogyott</dt>
          <dd className="mt-1 text-2xl font-medium">{formatTokens(model.total)} token</dd>
          <dd className="text-sm text-ink-3">a heti {formatTokens(model.limit)} tokenből</dd>
        </div>
        <div>
          <dt className="text-sm text-ink-3">{model.overage > 0 ? "Túllépés" : "Maradt"}</dt>
          <dd className="mt-1 text-2xl font-medium">
            {formatTokens(model.overage > 0 ? model.overage : model.remaining)} token
          </dd>
          <dd className="text-sm text-ink-3">
            a ciklus {formatPercent(nowFraction)}-a telt el
          </dd>
        </div>
        <div>
          <dt className="text-sm text-ink-3">Reset</dt>
          <dd className="mt-1 text-2xl font-medium">
            {formatDuration(model.cycle.endMs - model.generatedAt)} múlva
          </dd>
          <dd className="text-sm text-ink-3">{formatWeekdayTime(model.cycle.endMs, model.timeZone)}</dd>
        </div>
      </dl>
    </section>
  );
}
