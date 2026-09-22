import { CycleRuler } from "@/components/cycle-ruler";
import { AlertTriangleIcon, CheckCircleIcon, InfoCircleIcon, StopCircleIcon } from "@/components/icons";
import type { DashboardModel } from "@/lib/dashboard";
import {
  formatCycleMoment,
  formatDuration,
  formatHeroPercent,
  formatPercent,
  formatTokens,
  periodAdjective,
} from "@/lib/format";
import type { DashboardView } from "@/lib/ground-truth";
import type { QuotaAssessment } from "@/lib/quota";

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

export function statusLabel(quota: QuotaAssessment): string {
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

function formatMoment(ms: number, model: DashboardModel): string {
  return formatCycleMoment(ms, model.period, model.timeZone);
}

function paceSentence(model: DashboardModel, view: DashboardView, quota: QuotaAssessment): string {
  const { total, limit, pace } = quota;
  if (total >= limit) {
    // With the remaining tokens switched off, the overage (tokens left, below zero) stays unsaid too.
    // Without a token limit there are no tokens to state at all.
    if (!view.inTokens || !model.showRemaining) {
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

/** The bar is a meter while something fills it; until then it only carries the cycle's ruler. */
function meterAttributes(
  model: DashboardModel,
  quota: QuotaAssessment | null,
  tokenQuota: QuotaAssessment | null,
): React.HTMLAttributes<HTMLDivElement> {
  if (!quota) return { "aria-hidden": true };
  const label = model.period === "monthly" ? "Havi" : "Heti";
  if (tokenQuota) {
    return {
      role: "meter",
      "aria-label": `${label} tokenkeret`,
      "aria-valuemin": 0,
      "aria-valuemax": tokenQuota.limit,
      "aria-valuenow": Math.round(Math.min(tokenQuota.total, tokenQuota.limit)),
      "aria-valuetext": `${formatTokens(tokenQuota.total)} / ${formatTokens(tokenQuota.limit)} token, ${formatHeroPercent(tokenQuota.usedFraction)}`,
    };
  }
  return {
    role: "meter",
    "aria-label": `${label} keret`,
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    "aria-valuenow": Math.round(Math.min(1, quota.usedFraction) * 1000) / 10,
    "aria-valuetext": `${formatHeroPercent(quota.usedFraction)}, hivatalos érték`,
  };
}

/**
 * The page's one gauge: usage against the limit, laid over the cycle itself.
 * Fill ahead of the "most" marker means burning faster than time passes.
 * Without a token limit only an official reading fills it.
 */
export function QuotaMeter({ model, view }: { model: DashboardModel; view: DashboardView }) {
  const { quota } = view;
  // Token amounts mean tokens only against a limit: without one `quota` counts fractions of the budget.
  const tokenQuota = view.inTokens ? quota : null;
  const showRemaining = tokenQuota !== null && model.showRemaining;
  const style = quota ? STATUS_STYLE[quota.status] : UNKNOWN_STYLE;
  const StatusIcon = style.icon;
  const period = periodAdjective(model.period);
  const fillPercent = quota ? Math.min(1, quota.usedFraction) * 100 : 0;
  const nowFraction = model.cycle.elapsedFraction;
  const nowAlign =
    nowFraction < 0.05 ? "translate-x-0" : nowFraction > 0.95 ? "-translate-x-full" : "-translate-x-1/2";
  const elapsedNote = `a ciklus ${formatPercent(nowFraction)}-a telt el`;

  return (
    <section aria-labelledby="quota-heading">
      <h1 id="quota-heading" className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        {quota ? (
          <>
            <span className="hero-figure">{formatHeroPercent(quota.usedFraction)}</span>
            <span className="text-xl text-ink-2 sm:text-2xl">elfogyott a {period} keretből</span>
          </>
        ) : (
          <>
            <span aria-hidden="true" className="hero-figure text-ink-3">
              –%
            </span>
            <span className="text-xl text-ink-2 sm:text-2xl">még nincs hivatalos érték</span>
          </>
        )}
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
          {...meterAttributes(model, quota, tokenQuota)}
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

        <CycleRuler model={model} />
      </div>

      <p className="mt-6 flex max-w-2xl items-start gap-2.5 text-base text-ink-2">
        <StatusIcon className={`mt-1 shrink-0 ${style.iconColor}`} />
        {quota ? (
          <span>
            <strong className="font-medium text-ink">{statusLabel(quota)}</strong> {paceSentence(model, view, quota)}
          </span>
        ) : (
          <span>
            <strong className="font-medium text-ink">A keret állása a hivatalos értékből derül ki.</strong> Írd be
            fent a százalékot: a tempó és a bontás abból számol.
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
            <dt className="text-sm text-ink-3">Elfogyott</dt>
            <dd className="mt-1 text-2xl font-medium">{formatTokens(tokenQuota.total)} token</dd>
            <dd className="text-sm text-ink-3">
              a {period} {formatTokens(tokenQuota.limit)} tokenből
            </dd>
          </div>
        ) : (
          <div>
            <dt className="text-sm text-ink-3">Mért fogyasztás</dt>
            <dd className="mt-1 text-2xl font-medium">{formatTokens(view.measured.total)} token</dd>
            <dd className="text-sm text-ink-3">a gépek mérése szerint</dd>
          </div>
        )}
        {showRemaining && tokenQuota && (
          <div>
            <dt className="text-sm text-ink-3">{tokenQuota.overage > 0 ? "Túllépés" : "Maradt"}</dt>
            <dd className="mt-1 text-2xl font-medium">
              {formatTokens(tokenQuota.overage > 0 ? tokenQuota.overage : tokenQuota.remaining)} token
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
            {!showRemaining && <> · {elapsedNote}</>}
          </dd>
        </div>
      </dl>
    </section>
  );
}
