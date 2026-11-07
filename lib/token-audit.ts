import type { AuditAction } from "@/lib/api-token";
import { auditRecord } from "@/lib/token-vault";
import type { TokenAudit } from "@/lib/tokens";
import { loadUser } from "@/lib/users";

/**
 * The audit entries a request writes for the per-machine tokens it changes (lib/tokens.ts takes
 * them as a `TokenAudit`): the request's browser and address, as for the shared token, and in
 * multi-tenant mode the GitHub login of the user who did it.
 */
export function tokenAudit(
  action: Extract<AuditAction, "token_created" | "token_revoked" | "token_rotated">,
  actor: { userId: string | null },
  now: Date,
): TokenAudit {
  let by: Promise<string | null> | null = null;
  return async (token) => {
    by ??= actor.userId ? loadUser(actor.userId).then((user) => user?.login || null) : Promise.resolve(null);
    return auditRecord(action, now, { token, by: await by });
  };
}
