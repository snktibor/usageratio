"use client";

import { useTranslations } from "next-intl";
import { LanguageSwitcher } from "@/components/language-switcher";

/** The settings page's language control: the header's `LanguageSwitcher`, under a heading of its own. */
export function LanguageSection({
  titleId,
  confirmLeave,
}: {
  titleId: string;
  confirmLeave: (proceed: () => void) => void;
}) {
  const t = useTranslations("Settings");

  return (
    <section aria-labelledby={`${titleId}-language`}>
      <h3 id={`${titleId}-language`} className="font-medium">
        {t("language_heading")}
      </h3>
      <div className="mt-2">
        <LanguageSwitcher confirmLeave={confirmLeave} />
      </div>
    </section>
  );
}
