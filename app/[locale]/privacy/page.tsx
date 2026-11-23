import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { LegalPage, legalRich, legalSections } from "@/components/legal/legal-page";
import { routing } from "@/i18n/routing";
import { legalOperator, PRIVACY_SPEC } from "@/lib/legal";

/** The privacy notice (GDPR Articles 13–14): public, and only on an instance that names its operator (lib/legal.ts). */

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale: hasLocale(routing.locales, locale) ? locale : "en", namespace: "Privacy" });
  return { title: t("heading"), robots: { index: false, follow: false } };
}

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (hasLocale(routing.locales, locale)) setRequestLocale(locale);
  const operator = legalOperator();
  if (!operator) notFound();

  const t = await getTranslations("Privacy");
  const rich = legalRich(operator);
  const sections = legalSections(
    PRIVACY_SPEC,
    (key) => t.rich(key, rich),
    (key) => t(key),
  );
  return <LegalPage heading={t("heading")} intro={t.rich("intro", rich)} sections={sections} />;
}
