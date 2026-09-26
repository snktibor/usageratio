import { createNavigation } from "next-intl/navigation";
import { defineRouting } from "next-intl/routing";
import { locales } from "./locales.generated";

export const routing = defineRouting({
  locales,
  // English for a visitor whose browser asks for no listed language; the
  // Accept-Language header and the NEXT_LOCALE cookie pick the others.
  defaultLocale: "en",
});

// Locale-aware navigation APIs: mirrors next/link and next/navigation, but keeps the current locale.
export const { Link, redirect, usePathname, useRouter } = createNavigation(routing);
