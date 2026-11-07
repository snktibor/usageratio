import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { SignInGate } from "@/components/auth/sign-in-gate";
import { StorageProblem } from "@/components/storage-problem";
import { TenantGuard } from "@/components/tenant-guard";
import { WorkspaceMembers } from "@/components/workspace/workspace-members";
import { routing } from "@/i18n/routing";
import { log } from "@/lib/log";
import { StorageNotConfiguredError } from "@/lib/redis";
import { isMultiTenant } from "@/lib/registration";
import { currentTenant } from "@/lib/tenant-context";
import { loadWorkspaceView, type WorkspaceView } from "@/lib/workspace";

/** The current workspace's people and invites (multi-tenant mode only). */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function WorkspacePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (hasLocale(routing.locales, locale)) setRequestLocale(locale);
  if (!isMultiTenant()) notFound();

  let workspace: WorkspaceView | null = null;
  let storageError: unknown = null;
  try {
    const tenant = await currentTenant();
    if (tenant) workspace = await loadWorkspaceView(tenant, new Date());
  } catch (error) {
    storageError = error;
    log.error("workspace_page.load_failed", { err: error });
  }

  if (storageError) {
    return <StorageProblem notConfigured={storageError instanceof StorageNotConfiguredError} />;
  }
  if (!workspace) return <SignInGate next="/workspace" />;
  return (
    <>
      <TenantGuard tenantId={workspace.tenantId} />
      <WorkspaceMembers workspace={workspace} />
    </>
  );
}
