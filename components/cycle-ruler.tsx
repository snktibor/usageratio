import type { DashboardModel } from "@/lib/dashboard";
import { weekdayShort } from "@/lib/format";
import { useLocale } from "next-intl";

type Segment = DashboardModel["cycle"]["segments"][number];

/**
 * The text under one day of the ruler. A week names every day that has the
 * room. A month does not have it: today, the 1st and every fifth day are
 * named, minus the ones that would run into today's.
 */
function rulerLabel(
  model: DashboardModel,
  segment: Segment,
  index: number,
  todayIndex: number,
  locale: string,
): string | null {
  const width = segment.endFraction - segment.startFraction;
  if (model.period === "weekly") return width >= 0.07 ? weekdayShort(segment.weekday, locale) : null;

  if (width < 0.02) return null;
  const isLandmark = segment.monthDay === 1 || segment.monthDay % 5 === 0;
  const named = index === todayIndex || (isLandmark && Math.abs(index - todayIndex) !== 1);
  return named ? `${segment.monthDay}.` : null;
}

/** The days of the cycle, left to right across the full width: under the meter and under the charts. */
export function CycleRuler({ model }: { model: DashboardModel }) {
  const locale = useLocale();
  const nowFraction = model.cycle.elapsedFraction;
  const todayIndex = model.cycle.segments.findIndex(
    (segment) => nowFraction >= segment.startFraction && nowFraction < segment.endFraction,
  );

  return (
    <div aria-hidden="true" className="relative mt-2 h-7">
      {model.cycle.segments.map((segment, index) => {
        const label = rulerLabel(model, segment, index, todayIndex, locale);
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
  );
}
