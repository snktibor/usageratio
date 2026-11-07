import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { SignupFrame } from "@/components/auth/sign-in-gate";
import { SignupRedeem } from "@/components/auth/signup-redeem";
import { routing } from "@/i18n/routing";
import { registrationMode } from "@/lib/registration";

/** A workspace invite (`/join#code`): only on a multi-tenant instance. */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function JoinPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (hasLocale(routing.locales, locale)) setRequestLocale(locale);
  if (registrationMode() === "closed") notFound();
  return (
    <SignupFrame kind="join">
      <SignupRedeem purpose="join" />
    </SignupFrame>
  );
}
