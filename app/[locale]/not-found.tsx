import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/routing";

/**
 * The 404 page, inside the locale layout: reached through `notFound()`,
 * which the catch-all `[...rest]/page.tsx` calls for any unmatched path.
 */
export default async function NotFoundPage() {
  const t = await getTranslations("Errors");

  return (
    <main className="mx-auto w-full max-w-4xl px-5 pt-6 sm:px-8 sm:pt-8">
      <p className="text-lg font-medium tracking-tight">usageratio</p>
      <div className="mt-[18vh] max-w-xl">
        <h1 className="text-4xl font-semibold tracking-tight">{t("not_found_title")}</h1>
        <p className="mt-4 text-ink-2">{t("not_found_desc")}</p>
        <Link
          href="/"
          className="mt-8 inline-block rounded-md bg-ink px-4 py-2.5 font-medium text-page transition-opacity hover:opacity-90"
        >
          {t("back_home")}
        </Link>
      </div>
    </main>
  );
}
