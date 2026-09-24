import createMiddleware from 'next-intl/middleware';
import {routing} from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  // Olyan útvonalakra illeszkedjen, ahol szükségünk van a nyelvi váltásra.
  // Kizárja az API végpontokat, a statikus fájlokat, stb.
  matcher: ['/', '/(hu|en)/:path*', '/((?!api|_next|_vercel|.*\\..*).*)']
};
