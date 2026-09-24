import {defineRouting} from 'next-intl/routing';
import {createNavigation} from 'next-intl/navigation';

export const routing = defineRouting({
  locales: ['hu', 'en'],
  defaultLocale: 'hu',
});

// A next-intl ezeket a navigációs horgokat fogja biztosítani, amelyek tudnak az aktuális nyelvről
export const {Link, redirect, usePathname, useRouter} = createNavigation(routing);
