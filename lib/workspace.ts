import { type InviteEntry, listInvites } from "@/lib/invites";
import { listMembers, type Member } from "@/lib/members";
import type { TenantContext } from "@/lib/tenant-context";
import type { TenantId } from "@/lib/tenant-id";
import { loadTenantRecord } from "@/lib/tenants";
import type { Role } from "@/lib/users";

/**
 * What the workspace page (app/[locale]/workspace) and GET /api/workspace
 * show: the current workspace, its people, and, to its owner only, the
 * pending invites.
 */
export interface WorkspaceView {
  tenantId: TenantId;
  name: string;
  role: Role;
  /** The signed-in user's own id, to tell their row apart. */
  you: string | null;
  members: Member[];
  invites: InviteEntry[];
}

export async function loadWorkspaceView(tenant: TenantContext, now: Date): Promise<WorkspaceView> {
  const { tenantId } = tenant.store;
  const [record, members, invites] = await Promise.all([
    loadTenantRecord(tenantId),
    listMembers(tenantId),
    tenant.role === "owner" ? listInvites(tenantId, now) : Promise.resolve([]),
  ]);
  return { tenantId, name: record?.name ?? tenantId, role: tenant.role, you: tenant.userId, members, invites };
}
