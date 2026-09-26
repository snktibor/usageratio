import { getTranslations } from "next-intl/server";

/** Shown on every page in demo mode: the data is synthetic and nothing is saved. */
export async function DemoBanner() {
  const t = await getTranslations("Common");
  return (
    <div role="status" className="border-b border-hairline bg-raised px-5 py-2 text-center text-sm text-ink-2">
      {t("demo_banner")}{" "}
      <a
        href="https://github.com/snktibor/usageratio"
        target="_blank"
        rel="noreferrer"
        className="underline decoration-ink-3 underline-offset-2 transition-colors hover:text-ink"
      >
        {t("demo_banner_link")}
      </a>
    </div>
  );
}
