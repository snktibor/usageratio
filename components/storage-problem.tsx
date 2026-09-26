import { getTranslations } from "next-intl/server";

/** Shown instead of the dashboard when Redis is missing or unreachable. Carries no usage data. */
export async function StorageProblem({ notConfigured }: { notConfigured: boolean }) {
  const t = await getTranslations("HomePage");

  return (
    <main className="mx-auto w-full max-w-4xl px-5 pt-6 sm:px-8 sm:pt-8">
      <p className="text-lg font-medium tracking-tight">usageratio</p>

      <div className="mt-[18vh] max-w-xl">
        <h1 className="text-4xl font-semibold tracking-tight">
          {notConfigured ? t("storage_not_configured_title") : t("storage_unavailable_title")}
        </h1>
        {notConfigured ? (
          <p className="mt-4 text-ink-2">
            {t.rich("storage_not_configured_desc", {
              code: (chunks) => <code className="text-ink">{chunks}</code>,
            })}
          </p>
        ) : (
          <p className="mt-4 text-ink-2">{t("storage_unavailable_desc")}</p>
        )}
        <a
          href="/"
          className="mt-8 inline-block rounded-md bg-ink px-4 py-2.5 font-medium text-page transition-opacity hover:opacity-90"
        >
          {t("storage_reload")}
        </a>
      </div>
    </main>
  );
}
