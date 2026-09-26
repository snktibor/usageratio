import { getTranslations } from "next-intl/server";

/**
 * The dashboard's instant loading state: the page shell while the store is
 * read (two round trips on a cold start). Layout only, no numbers.
 */
export default async function DashboardLoading() {
  const t = await getTranslations("Errors");

  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="mx-auto w-full max-w-4xl px-5 pb-16 pt-6 sm:px-8 sm:pt-8"
    >
      <span className="sr-only">{t("loading")}</span>
      <div className="flex items-center justify-between gap-4">
        <p className="text-lg font-medium tracking-tight">usageratio</p>
        <div aria-hidden="true" className="flex items-center gap-3">
          <span className="h-8 w-24 rounded-md bg-raised" />
          <span className="h-8 w-24 rounded-md bg-raised" />
        </div>
      </div>
      <div aria-hidden="true" className="mt-12 animate-pulse space-y-6">
        <div className="h-5 w-40 rounded bg-raised" />
        <div className="h-28 w-64 rounded-lg bg-raised" />
        <div className="h-3.5 w-full rounded-full bg-raised" />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="h-24 rounded-lg bg-raised" />
          <div className="h-24 rounded-lg bg-raised" />
        </div>
        <div className="h-56 rounded-lg bg-raised sm:h-64" />
      </div>
    </div>
  );
}
