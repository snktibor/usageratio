"use client";

import { useTransition } from "react";
import { useRouter, usePathname } from "@/i18n/routing";
import { useLocale, useTranslations } from "next-intl";

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
        <option value="hu">🇭🇺 HU</option>
        <option value="en">🇬🇧 EN</option>
        <option value="de">🇩🇪 DE</option>
      </select>
    </div>
  );
}
