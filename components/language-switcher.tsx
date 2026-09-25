"use client";

import { useTransition } from "react";
import { routing, useRouter, usePathname } from "@/i18n/routing";
import { useLocale, useTranslations } from "next-intl";

/** The language's own name in itself (e.g. "Deutsch", "English"), so a new
 * messages/<locale>.json needs no matching label added here. */
function localeLabel(locale: string) {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

/** CLDR's most likely region for the locale (e.g. "hu" -> "HU"), turned into
 * its flag emoji. A guess, not a curated choice — but needs no maintenance
 * when a new messages/<locale>.json shows up. */
function localeFlag(locale: string) {
  try {
    const region = new Intl.Locale(locale).maximize().region;
    if (!region) return "";
    return [...region.toUpperCase()]
      .map((char) => String.fromCodePoint(0x1f1e6 + char.charCodeAt(0) - 65))
      .join("");
  } catch {
    return "";
  }
}

export function LanguageSwitcher() {
  const t = useTranslations("Common");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextLocale = e.target.value;
    startTransition(() => {
      router.replace(pathname, { locale: nextLocale });
    });
  };

  return (
    <div className="flex items-center">
      <label htmlFor="language-select" className="sr-only">
        {t("language")}
      </label>
      <select
        id="language-select"
        value={locale}
        onChange={onChange}
        disabled={isPending}
        className="rounded-md border border-rule bg-transparent px-2.5 py-1.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink focus:border-ink-3 focus:outline-none disabled:opacity-50"
      >
        {routing.locales.map((loc) => (
          <option key={loc} value={loc}>
            {[localeFlag(loc), localeLabel(loc)].filter(Boolean).join(" ")}
          </option>
        ))}
      </select>
    </div>
  );
}
