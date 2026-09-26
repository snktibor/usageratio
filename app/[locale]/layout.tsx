import type { Metadata, Viewport } from "next";
import { Instrument_Sans } from "next/font/google";
import "../globals.css";

// latin-ext carries ő and ű; the width axis is used by the hero figure.
const instrumentSans = Instrument_Sans({
  subsets: ["latin", "latin-ext"],
  axes: ["wdth"],
  variable: "--font-instrument",
  display: "swap",
});

export const metadata: Metadata = {
  title: "usageratio",
  description: "AI-tokenkeretek szolgáltatók, gépek és csoportok szerint.",
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  themeColor: "#1a1a19",
  colorScheme: "dark",
};

import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { DemoBanner } from "@/components/demo-banner";
import { routing } from "@/i18n/routing";
import { isDemoMode } from "@/lib/demo/mode";

export default async function RootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!routing.locales.includes(locale as any)) {
    notFound();
  }

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
