"use client";

import { useId, useMemo } from "react";
import { AlertTriangleIcon, CheckCircleIcon, InfoCircleIcon, StopCircleIcon } from "@/components/icons";
import { statusLabel } from "@/components/quota-meter";
import { useOfficialEntry } from "@/components/use-official-entry";
import type { DashboardModel } from "@/lib/dashboard";
import { formatCycleMoment, formatHeroPercent, formatPercent, formatTokens } from "@/lib/format";
import {
  applySubLimitReading,
  parseOfficialPercent,
  type DashboardView,
  type SubLimitView,
} from "@/lib/ground-truth";
import type { SubLimitModel } from "@/lib/sub-limits";

/** The slider's own colour carries the severity, next to the icon and the label below it. */
const STATUS_STYLE = {
  good: { accent: "accent-ink", icon: CheckCircleIcon, iconColor: "text-good" },
  warning: { accent: "accent-warning", icon: AlertTriangleIcon, iconColor: "text-warning" },
  critical: { accent: "accent-critical", icon: StopCircleIcon, iconColor: "text-critical" },
} as const;
const UNKNOWN_STYLE = { accent: "accent-ink", icon: InfoCircleIcon, iconColor: "text-ink-3" } as const;

interface RowProps {
  model: DashboardModel;
  view: DashboardView;
  sub: SubLimitModel;
  providerId: string;
  providerLabel: string;
}

function modeNote(sub: SubLimitModel): string {
  return sub.shareCap === null ? "önálló keret" : `a keret legfeljebb ${formatPercent(sub.shareCap)}-a`;
}

/** Where the figure comes from, and what it means for the provider's whole budget. */
function sourceNote(subView: SubLimitView, providerLabel: string): string {
  const { sub, source, ofProvider } = subView;
  const measured = `A gépek ${formatTokens(sub.total)} tokent mértek rá.`;
  const ofWhole =
    ofProvider !== null && sub.shareCap !== null
      ? ` A teljes ${providerLabel}-keret ${formatPercent(ofProvider)}-a, a megengedett ${formatPercent(sub.shareCap)}-ból.`
      : "";
  if (source === "official") return `Hivatalos érték.${ofWhole}`;
  if (source === "provider") {
    return `A(z) ${providerLabel} hivatalos százalékából, a mért arány szerint.${ofWhole} ${measured}`;
  }
  // Measured: against its own token limit, or (a part) against the provider's.
  const limit = sub.quota ? ` a ${formatTokens(sub.quota.limit)} tokenes keretéből` : "";
  return sub.shareCap === null
    ? `A gépek mérése szerint${limit}. ${measured}`
    : `A gépek mérése szerint.${ofWhole} ${measured}`;
}

function paceNote(subView: SubLimitView, model: DashboardModel): string {
  const quota = subView.quota!;
  if (quota.total >= 1 || quota.total === 0 || quota.pace.earlyBurn) return "";
  if (quota.pace.runOutAt !== null) {
    return ` Ilyen ütemben ${formatCycleMoment(quota.pace.runOutAt, model.period, model.timeZone)} körül fogy el.`;
  }
  if (quota.pace.projectedTotal !== null) {
    return ` Ilyen ütemben a resetig kb. ${formatPercent(quota.pace.projectedTotal)}-a fogy el.`;
  }
  return "";
}

/** Nothing tells how far it is yet: what would. */
function unknownNote(subView: SubLimitView, providerLabel: string): string {
  const { sub } = subView;
  if (!sub.hasSplit) {
    return (
      `A gépek ebben a ciklusban még nem küldtek modellenkénti bontást, így a(z) ${sub.name} mért része nem ` +
      "ismert. Írd be a hivatalos százalékát."
    );
  }
  if (sub.shareCap !== null) {
    return (
      `Írd be a(z) ${sub.name} hivatalos százalékát, vagy fent a(z) ${providerLabel} értékét: abból a mért ` +
      "arány szerint kiszámolható."
    );
  }
  return `Írd be, hány százalékon áll a(z) ${sub.name} kerete a(z) ${providerLabel} saját kijelzőjén.`;
}

/**
 * One sub-limit: a smaller twin of the official-usage field above it, with
 * its own entry, and a line on how it stands.
 */
function SubLimitRow({ model, view, sub, providerId, providerLabel }: RowProps) {
  const [entry, setEntry] = useOfficialEntry(providerId, model.cycle.startMs, sub.id);
  const { percent, invalid } = parseOfficialPercent(entry.raw);
  const subView = useMemo(
    () => applySubLimitReading(model, view, sub, percent === null ? null : { percent, atMs: entry.enteredAt }),
    [model, view, sub, percent, entry.enteredAt],
  );
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
          <span className="ml-2 text-sm text-ink-3 sm:ml-0 sm:block">{modeNote(sub)}</span>
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
            aria-label={`Hivatalos ${sub.name}-fogyasztás, csúszka`}
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
              Törlés
            </button>
          )}
        </div>
      </div>

      <p id={hintId} className={`mt-2 flex max-w-3xl items-start gap-2 text-sm ${invalid ? "text-ink" : "text-ink-3"}`}>
        <StatusIcon className={`mt-0.5 shrink-0 ${invalid ? "text-critical" : style.iconColor}`} />
        {invalid ? (
          <span>0 és 100 közötti számot adj meg, például 45 vagy 45,5.</span>
        ) : quota ? (
          <span>
            <strong className="font-medium text-ink">
              {formatHeroPercent(quota.usedFraction)} elfogyott. {statusLabel(quota)}
            </strong>
            {paceNote(subView, model)} {sourceNote(subView, providerLabel)}
          </span>
        ) : (
          <span>{unknownNote(subView, providerLabel)}</span>
        )}
      </p>
    </li>
  );
}

/** The provider's sub-limits under its official-usage field; nothing while it has none. */
export function SubLimitMeters({
  model,
  view,
  providerId,
  providerLabel,
}: {
  model: DashboardModel;
  view: DashboardView;
  providerId: string;
  providerLabel: string;
}) {
  if (model.subLimits.length === 0) return null;
  const hasSeparate = model.subLimits.some((sub) => sub.shareCap === null);

  return (
    <div className="mt-5 border-t border-hairline pt-5">
      <h3 className="text-sm text-ink-3">Alkeretek</h3>
      <ul className="mt-3 space-y-5">
        {model.subLimits.map((sub) => (
          <SubLimitRow
            key={sub.id}
            model={model}
            view={view}
            sub={sub}
            providerId={providerId}
            providerLabel={providerLabel}
          />
        ))}
      </ul>
      {hasSeparate && (
        <p className="mt-4 max-w-3xl text-sm text-ink-3">
          Az önálló keretek modelljei nem számítanak bele a(z) {providerLabel} keretébe: a fenti százalék, a
          csoportok és a gépek tokenjei nélkülük értendők.
        </p>
      )}
    </div>
  );
}
