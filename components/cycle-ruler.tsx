import { useLocale } from "next-intl";
import type { DashboardModel, DaySpan } from "@/lib/dashboard";
import { formatMonthDay, weekdayShort } from "@/lib/format";

/** What a ruler lays out: the days of a stretch of time, and how far into it now is. */
export interface RulerSpan {
  elapsedFraction: number;
  days: DaySpan[];
}

/**
 * The text under one day of the ruler. A week names every day that has the
 * room. A month does not have it: today, the 1st and every fifth day are
 * named, minus the ones that would run into today's.
 */
function rulerLabel(
  model: DashboardModel,
  day: DaySpan,
  index: number,
  todayIndex: number,
  locale: string,
): string | null {
  const width = day.endFraction - day.startFraction;
  if (model.period === "weekly") return width >= 0.07 ? weekdayShort(day.weekday, locale) : null;

  if (width < 0.02) return null;
  const isLandmark = day.monthDay === 1 || day.monthDay % 5 === 0;
  const named = index === todayIndex || (isLandmark && Math.abs(index - todayIndex) !== 1);
  return named ? formatMonthDay(day.monthDay, locale) : null;
}

/**
 * The days of `span`, left to right across the full width: the current
 * segment under the meter (lib/dashboard.ts `segment`), the whole cycle under
 * the charts.
 */
export function CycleRuler({ model, span }: { model: DashboardModel; span: RulerSpan }) {
  const locale = useLocale();
  const nowFraction = span.elapsedFraction;
  const todayIndex = span.days.findIndex((day) => nowFraction >= day.startFraction && nowFraction < day.endFraction);

  return (
    <div aria-hidden="true" className="relative mt-2 h-7">
      {span.days.map((day, index) => {
        const label = rulerLabel(model, day, index, todayIndex, locale);
        return (
          <div
            key={day.startFraction}
            className="absolute top-0 h-full"
            style={{
              left: `${day.startFraction * 100}%`,
              width: `${(day.endFraction - day.startFraction) * 100}%`,
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
  );
}
