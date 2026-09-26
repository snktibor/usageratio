import { createNavigation } from "next-intl/navigation";
import { defineRouting } from "next-intl/routing";
import { locales } from "./locales.generated";

export const routing = defineRouting({
  locales,
  defaultLocale: "hu",
});

// Locale-aware navigation APIs: mirrors next/link and next/navigation, but keeps the current locale.
export const { Link, redirect, usePathname, useRouter } = createNavigation(routing);
