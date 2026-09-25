import createMiddleware from 'next-intl/middleware';
import {routing} from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  // Matches routes that need locale handling.
  // Excludes API endpoints, static files, etc.
  matcher: ['/', '/(hu|en|de)/:path*', '/((?!api|_next|_vercel|.*\\..*).*)']
};
