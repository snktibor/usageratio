import { apiError, json, requireSameOrigin, requireTenantSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { demoReadOnly } from "@/lib/demo/mode";
import { manageAudit } from "@/lib/manage-audit";
import { restoreTrash, TRASH_ID_PATTERN } from "@/lib/trash";

/**
 * POST /api/trash/[id]/restore — puts a recently deleted group or provider back: its reports
 * (unioned with any that arrived since, AGGREGATE MAX, the rule a group merge reads by; reports
 * past the retention are dropped), its index entries where none has been re-created, its settings
 * parts, and the archived cycle summaries written while it was away. Needs a fresh sudo grant, like
 * the delete it undoes; on the manage audit trail (GET /api/manage/audit).
 *
 *   POST → { "ok": true, "kind", "id", "restored": { events, machines }, "merged": bool,
 *            "group"?: { "id", "color", "excluded": [providerId] } }
 *
 * 200 ok · 400 invalid id · 401 no session · 403 foreign origin, demo mode, or no sudo grant ·
 * 404 not_found (no such entry, or it expired) · 409 too_many_groups | too_many_providers |
 * too_many_machines (the workspace's quota, lib/quotas.ts, with its `limit`) · 412 tenant_changed · 503 Redis down
 */

type Params = { id: string };

const REFUSALS = { too_many_groups: 409, too_many_providers: 409, too_many_machines: 409 } as const;

export async function POST(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { id } = await context.params;
  return withApiHandler("api/trash/[id]/restore", async () => {
    const origin = requireSameOrigin(request);
    if (origin) return origin;
    const readOnly = demoReadOnly();
    if (readOnly) return readOnly;
    const tenant = await requireTenantSession();
    if (tenant instanceof Response) return tenant;
    if (!(await hasSudo())) return apiError("sudo_required", 403);
    if (!TRASH_ID_PATTERN.test(id)) return apiError("invalid_payload", 400, { details: ["invalid trash id"] });

    const now = new Date();
    const result = await restoreTrash(tenant.store, id, now, { audit: manageAudit(tenant, now) });
    if (!result.ok) {
      return result.reason === "not_found"
        ? apiError("not_found", 404)
        : apiError(result.reason, REFUSALS[result.reason], { limit: result.limit });
    }
    const { ok: _ok, ...rest } = result;
    return json({ ok: true, ...rest }, 200);
  })(request);
}
