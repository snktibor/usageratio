import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { AccountView } from "@/components/account/account-view";
import { SignInGate } from "@/components/auth/sign-in-gate";
import { routing } from "@/i18n/routing";
import { loadAccount } from "@/lib/account";
import { isInstanceAdmin } from "@/lib/admin";
import { isMultiTenant } from "@/lib/registration";
import { currentUserSession } from "@/lib/user-session";

/** The signed-in user's account (multi-tenant mode only). */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AccountPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (hasLocale(routing.locales, locale)) setRequestLocale(locale);
  if (!isMultiTenant()) notFound();
  const session = await currentUserSession();
  const account =
    session && (await loadAccount(session.userId, { sessionHash: session.hash, tenantId: session.tenantId }));
  if (!session || !account) return <SignInGate next="/account" />;
  return <AccountView account={account} admin={await isInstanceAdmin(session.userId)} />;
}
