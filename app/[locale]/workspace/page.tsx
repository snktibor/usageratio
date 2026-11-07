import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { SignInGate } from "@/components/auth/sign-in-gate";
import { TenantGuard } from "@/components/tenant-guard";
import { WorkspaceMembers } from "@/components/workspace/workspace-members";
import { routing } from "@/i18n/routing";
import { isMultiTenant } from "@/lib/registration";
import { currentTenant } from "@/lib/tenant-context";
import { loadWorkspaceView } from "@/lib/workspace";

/** The current workspace's people and invites (multi-tenant mode only). */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function WorkspacePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (hasLocale(routing.locales, locale)) setRequestLocale(locale);
  if (!isMultiTenant()) notFound();
  const tenant = await currentTenant();
  if (!tenant) return <SignInGate next="/workspace" />;
  const workspace = await loadWorkspaceView(tenant, new Date());
  return (
    <>
      <TenantGuard tenantId={tenant.store.tenantId} />
      <WorkspaceMembers workspace={workspace} />
    </>
  );
}
