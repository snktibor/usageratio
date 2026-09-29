import { getTranslations } from "next-intl/server";

/** The settings page's instant loading state: its header, the menu and the outline of the first sections. */
export default async function SettingsLoading() {
  const t = await getTranslations("Errors");

  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="mx-auto w-full max-w-5xl px-5 pb-16 pt-6 sm:px-8 sm:pt-8"
    >
      <span className="sr-only">{t("loading")}</span>
      <div className="flex items-center justify-between gap-4">
        <p className="text-lg font-medium tracking-tight">usageratio</p>
        <span aria-hidden="true" className="h-8 w-28 rounded-md bg-raised" />
      </div>
      <div aria-hidden="true" className="mt-12 animate-pulse">
        <div className="h-10 w-48 rounded bg-raised" />
        <div className="mt-10 gap-12 lg:grid lg:grid-cols-[11rem_minmax(0,1fr)]">
          <div className="flex flex-wrap gap-2 lg:flex-col">
            {Array.from({ length: 8 }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <span key={index} className="h-8 w-24 rounded-md bg-raised lg:w-full" />
            ))}
          </div>
          <div className="mt-10 space-y-6 lg:mt-0">
            <div className="h-6 w-32 rounded bg-raised" />
            <div className="h-10 w-40 rounded-md bg-raised" />
            <div className="h-24 rounded-lg bg-raised" />
            <div className="h-40 rounded-lg bg-raised" />
          </div>
        </div>
      </div>
    </div>
  );
}
