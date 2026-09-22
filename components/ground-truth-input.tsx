"use client";

import { useId } from "react";
import { StopCircleIcon } from "@/components/icons";
import { formatDateTime, formatFactor, formatPercent, formatTokens } from "@/lib/format";
import type { DashboardView } from "@/lib/ground-truth";

interface GroundTruthInputProps {
  /** The field's text, exactly as typed. */
  raw: string;
  onChange: (raw: string) => void;
  invalid: boolean;
  /** When the current text was entered; null while the field is empty. */
  enteredAt: number | null;
  view: DashboardView;
  timeZone: string;
  providerId: string;
  providerLabel: string;
  providers: { id: string; label: string }[];
  onProviderChange: (providerId: string) => void;
}

function hint({ invalid, enteredAt, view, timeZone, providerLabel }: GroundTruthInputProps): string {
  if (invalid) return "0 és 100 közötti számot adj meg, például 45 vagy 45,5.";
  if (!view.calibrated) {
    return (
      `Írd be, hány százalékon áll a keret a(z) ${providerLabel} saját kijelzőjén: a gépek és a csoportok ` +
      "fogyasztása ehhez igazodik. Üresen hagyva a gépek saját mérése számít."
    );
  }

  const entered = enteredAt === null ? "" : ` Megadva: ${formatDateTime(enteredAt, timeZone)}.`;
  if (view.scale === null) {
    return (
      "A gépek ebben a ciklusban még nem mértek fogyasztást, ezért a hivatalos érték nem osztható " +
      `szét gépekre és csoportokra.${entered}`
    );
  }
  return (
    `A gépek ${formatTokens(view.measured.total)} tokent mértek, ami a keret ` +
    `${formatPercent(view.measured.usedFraction)}-a. A bontás ${formatFactor(view.scale)} szorzóval ` +
    `igazodik a hivatalos értékhez.${entered}`
  );
}

/**
 * The official usage figure, typed or dragged. The page leads with it on
 * purpose: while it is filled in, every figure below is restated by it.
 */
export function GroundTruthInput(props: GroundTruthInputProps) {
  const { raw, onChange, invalid, view, providerId, providerLabel, providers, onProviderChange } = props;
  const fieldId = useId();
  const hintId = useId();

  // Left alone, the slider rests on the measured figure: dragging starts from what is known.
  const sliderValue = view.calibrated
    ? view.quota.usedFraction * 100
    : Math.min(1, view.measured.usedFraction) * 100;

  return (
    <section
      aria-label={`Hivatalos ${providerLabel}-fogyasztás`}
      className={`rounded-lg border bg-raised px-5 py-5 transition-colors sm:px-6 ${
        view.calibrated ? "border-ink-3" : "border-rule"
      }`}
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-4">
        <label htmlFor={fieldId} className="text-base font-medium">
          Aktuális hivatalos fogyasztás
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-3">
          <span>AI-fiók</span>
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

      <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
        <span className="text-sm text-ink-3">{providerLabel} valós százaléka</span>

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
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-lg text-ink-3">
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
            aria-label={`Aktuális hivatalos ${providerLabel} fogyasztás, csúszka`}
            aria-valuetext={`${Math.round(sliderValue)}%`}
            className={`order-3 h-6 w-full min-w-0 cursor-pointer accent-ink transition-opacity sm:order-2 sm:w-auto sm:grow ${
              view.calibrated ? "" : "opacity-50 hover:opacity-100 focus-visible:opacity-100"
            }`}
          />

          {raw !== "" && (
            <button
              type="button"
              onClick={() => onChange("")}
              className="order-2 ml-auto shrink-0 rounded-md border border-rule px-3 py-1.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink sm:order-3 sm:ml-0"
            >
              Törlés
            </button>
          )}
        </div>
      </div>

      <p id={hintId} className={`mt-4 flex max-w-3xl items-start gap-2 text-sm ${invalid ? "text-ink" : "text-ink-3"}`}>
        {invalid && <StopCircleIcon className="mt-0.5 shrink-0 text-critical" />}
        <span>{hint(props)}</span>
      </p>
    </section>
  );
}
