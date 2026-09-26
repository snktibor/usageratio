import type { Metadata, Viewport } from "next";
import { Instrument_Sans } from "next/font/google";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { DemoBanner } from "@/components/demo-banner";
import { routing } from "@/i18n/routing";
import { isDemoMode } from "@/lib/demo/mode";
import "../globals.css";

// latin-ext carries ő and ű; the width axis is used by the hero figure.
const instrumentSans = Instrument_Sans({
  subsets: ["latin", "latin-ext"],
  axes: ["wdth"],
  variable: "--font-instrument",
  display: "swap",
});

/**
 * The site's public address, for the metadata fields that need an absolute
 * URL (the Open Graph image, once there is one). NEXT_PUBLIC_SITE_URL wins;
 * Vercel tells the production domain; local development has neither.
 */
function siteUrl(): URL {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  for (const candidate of [configured, vercel && `https://${vercel}`]) {
    if (!candidate) continue;
    try {
      return new URL(candidate);
    } catch {
      // A malformed value must not take the whole site down: fall through.
    }
  }
  return new URL("http://localhost:3000");
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const requested = (await params).locale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const t = await getTranslations({ locale, namespace: "Metadata" });
  const description = t("description");
  return {
    metadataBase: siteUrl(),
    title: { default: "usageratio", template: "%s · usageratio" },
    description,
    applicationName: "usageratio",
    // A private dashboard: never indexed (app/robots.ts and the X-Robots-Tag header say the same).
    robots: { index: false, follow: false, nocache: true },
    openGraph: { type: "website", siteName: "usageratio", title: "usageratio", description },
    twitter: { card: "summary_large_image", title: "usageratio", description },
  };
}

export const viewport: Viewport = {
  themeColor: "#1a1a19",
  colorScheme: "dark",
};

export default async function RootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  // Lets the request config see the locale without reading request headers.
  setRequestLocale(locale);

  const messages = await getMessages();

  return (
    <html lang={locale} className={instrumentSans.variable}>
      <body className="min-h-dvh">
        <NextIntlClientProvider messages={messages}>
          {isDemoMode() && <DemoBanner />}
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
