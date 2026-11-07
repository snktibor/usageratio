import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { AdminView } from "@/components/admin/admin-view";
import { routing } from "@/i18n/routing";
import { adminOverview, isInstanceAdmin } from "@/lib/admin";
import { isMultiTenant } from "@/lib/registration";
import { listSignupCodes } from "@/lib/signup-codes";
import { currentUserSession } from "@/lib/user-session";

/** The instance admin's page: a 404 for everyone else, so it does not even show that it exists. */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AdminPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (hasLocale(routing.locales, locale)) setRequestLocale(locale);
  if (!isMultiTenant()) notFound();
  const session = await currentUserSession();
  if (!session || !(await isInstanceAdmin(session.userId))) notFound();
  const [overview, codes] = await Promise.all([adminOverview(), listSignupCodes()]);
  return <AdminView overview={overview} codes={codes} />;
}
