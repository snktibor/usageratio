import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  // Matches every route that needs locale handling, including locale-prefixed
  // ones — the catch-all below already covers those, so no per-locale entry
  // is needed here when a new language is added.
  // Excludes API endpoints, static files, etc.
  matcher: ["/", "/((?!api|_next|_vercel|.*\\..*).*)"],
};
