import { WORKSPACE_QUOTAS } from "@/lib/config";
import { listInvites } from "@/lib/invites";
import { memberCount } from "@/lib/members";
import { countMachines, machineCounting, type QuotaUse, workspaceQuotas } from "@/lib/quotas";
import { isMultiTenant } from "@/lib/registration";
import type { TenantStore } from "@/lib/tenant";
import { listTokens } from "@/lib/tokens";

/**
 * How much of its quotas (lib/quotas.ts) a workspace uses: the settings page
 * shows it to the workspace, the admin view to the instance admin. Only
 * counts: nothing here names a machine, group or provider.
 */
export interface WorkspaceQuotaUse {
  machines: QuotaUse;
  providers: QuotaUse;
  groups: QuotaUse;
  tokens: QuotaUse;
  /** Multi-tenant mode only: a single-user instance has no members or invites. */
  members: QuotaUse | null;
  pendingInvites: QuotaUse | null;
}

export async function loadQuotaUse(store: TenantStore, now: Date): Promise<WorkspaceQuotaUse> {
  const quotas = workspaceQuotas();
  const reads = store.redis.pipeline();
  reads.hkeys(store.keys.machines);
  reads.hlen(store.keys.providers);
  reads.hlen(store.keys.groups);
  const [[machineFields, providers, groups], tokens] = await Promise.all([
    reads.exec() as Promise<[unknown, unknown, unknown]>,
    listTokens(store),
  ]);
  const fields = (machineFields as unknown[]).map(String);
  const counts = {
    machines: { used: countMachines(fields, machineCounting()), limit: quotas.machines },
    providers: { used: Number(providers), limit: quotas.providers },
    groups: { used: Number(groups), limit: quotas.groups },
    tokens: { used: tokens.filter((token) => token.revokedAt === null).length, limit: quotas.tokens },
  };
  if (!isMultiTenant()) return { ...counts, members: null, pendingInvites: null };

  const [members, invites] = await Promise.all([memberCount(store.tenantId), listInvites(store.tenantId, now)]);
  return {
    ...counts,
    members: { used: members, limit: WORKSPACE_QUOTAS.members },
    pendingInvites: { used: invites.length, limit: WORKSPACE_QUOTAS.pendingInvites },
  };
}
