import { cookies } from "next/headers";
import { hasLocale, type Locale } from "next-intl";
import { routing } from "@/i18n/routing";

/**
 * The locale for a request outside next-intl's middleware, such as a route
 * handler (there is no request-scoped locale there, see i18n/request.ts): the
 * `?locale=` query parameter, else the `NEXT_LOCALE` cookie the middleware
 * leaves behind on every page visit (i18n/routing.ts does not override it),
 * else the default.
 */
export async function requestLocale(request: Request): Promise<Locale> {
  const query = new URL(request.url).searchParams.get("locale");
  if (hasLocale(routing.locales, query)) return query;

  const cookieLocale = (await cookies()).get("NEXT_LOCALE")?.value;
  if (hasLocale(routing.locales, cookieLocale)) return cookieLocale;

  return routing.defaultLocale;
}
