import { getTranslations } from "next-intl/server";

/** The setup page's instant loading state: its header and the outline of the form. */
export default async function SetupLoading() {
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
        <span aria-hidden="true" className="h-8 w-28 rounded-md bg-raised" />
      </div>
      <div aria-hidden="true" className="mt-12 animate-pulse space-y-6">
        <div className="h-9 w-56 rounded bg-raised" />
        <div className="h-4 w-full max-w-2xl rounded bg-raised" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="h-12 rounded-md bg-raised" />
          <div className="h-12 rounded-md bg-raised" />
        </div>
        <div className="h-10 w-80 rounded-md bg-raised" />
        <div className="h-40 rounded-lg bg-raised" />
      </div>
    </div>
  );
}
