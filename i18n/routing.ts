import {defineRouting} from 'next-intl/routing';
import {createNavigation} from 'next-intl/navigation';

export const routing = defineRouting({
  locales: ['hu', 'en'],
  defaultLocale: 'hu',
});

// Locale-aware navigation APIs: mirrors next/link and next/navigation, but keeps the current locale.
export const {Link, redirect, usePathname, useRouter} = createNavigation(routing);
