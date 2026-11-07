import { type AuditAction, type AuditRecord, serializeAuditRecord } from "@/lib/api-token";
import { auditFields } from "@/lib/token-vault";
import type { TokenAudit } from "@/lib/tokens";
import { loadUser } from "@/lib/users";

/**
 * The audit entries a request writes for the per-machine tokens it changes (lib/tokens.ts takes
 * them as a `TokenAudit`): the request's browser and address, as for the shared token, and in
 * multi-tenant mode the GitHub login of the user who did it. The request's part is worked out
 * once, however many tokens it changes (a member removed with all of their tokens).
 */
export function tokenAudit(
  action: Extract<AuditAction, "token_created" | "token_revoked" | "token_rotated">,
  actor: { userId: string | null },
  now: Date,
): TokenAudit {
  let base: Promise<AuditRecord> | null = null;
  return async (token) => {
    base ??= Promise.all([
      auditFields(action, now),
      actor.userId ? loadUser(actor.userId).then((user) => user?.login || null) : Promise.resolve(null),
    ]).then(([fields, by]) => ({ ...fields, by }));
    return serializeAuditRecord({ ...(await base), token });
  };
}
