"use client";

import { hasLocale, useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { routing, usePathname, useRouter } from "@/i18n/routing";

/**
 * The language's own name in itself ("Deutsch", "English", "magyar"), so a
 * new messages/<locale>.json needs no label added here. No flags: a language
 * is not a country.
 */
function localeLabel(locale: string) {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

/**
 * `confirmLeave`: asked before the switch, which reloads the page in the new
 * language; it calls `proceed` once the switch may go ahead (the settings
 * page asks first when there are unsaved changes).
 */
export function LanguageSwitcher({ confirmLeave }: { confirmLeave?: (proceed: () => void) => void } = {}) {
  const t = useTranslations("Common");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextLocale = e.target.value;
    if (!hasLocale(routing.locales, nextLocale)) return;
    const proceed = () =>
      startTransition(() => {
        router.replace(pathname, { locale: nextLocale });
      });
    if (confirmLeave) confirmLeave(proceed);
    else proceed();
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
        className="rounded-md border border-rule bg-transparent px-2.5 py-1.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink disabled:opacity-50"
      >
        {routing.locales.map((loc) => (
          <option key={loc} value={loc}>
            {localeLabel(loc)}
          </option>
        ))}
      </select>
    </div>
  );
}
