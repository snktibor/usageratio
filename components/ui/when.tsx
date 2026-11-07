"use client";

import { useLocale } from "next-intl";

/**
 * A moment as the reader's locale writes it (medium date, short time); "—" without one. Formatted
 * in the browser's own time zone, which may differ from the server's first render: hence the
 * hydration warning is suppressed on this element only.
 */
export function When({ ms }: { ms: number | null }) {
  const locale = useLocale();
  if (!ms) return <span>—</span>;
  return (
    <time dateTime={new Date(ms).toISOString()} suppressHydrationWarning>
      {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ms)}
    </time>
  );
}
