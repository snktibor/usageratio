import { apiError, json, requireSameOrigin, requireTenantSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { demoReadOnly } from "@/lib/demo/mode";
import { manageAudit } from "@/lib/manage-audit";
import { deleteProvider } from "@/lib/manage-store";
import { normalizeProviderId } from "@/lib/providers";

/**
 * DELETE /api/providers/[provider] — removes a provider outright: its events
 * in every group (kept in the trash for 30 days, see lib/trash.ts), its machines, its official-usage figures, and every trace
 * of it in the settings document (limits, sub-limits, hiddenProviders,
 * excludedProviders). The settings panel only offers this for a provider
 * already hidden. Needs a fresh sudo grant; `?force=1` is required when it
 * still has stored events, so a click cannot lose history by accident. A delete goes on the manage
 * audit trail (GET /api/manage/audit), in the same transaction; a dry run does not.
 *
 *   DELETE          → 409 provider_has_events unless it has none
 *   DELETE?force=1  → moves its reports to the trash for 30 days (`trashId` in the answer, GET /api/trash,
 *                     restorable)
 *   DELETE?dryRun=1 → what a forced delete would remove; writes nothing, needs no sudo
 *
 *   → { "ok": true, "affected": { events, machines, groups },
 *       "impact": { events, machines, groups, "lastReportAt": ms | null, "recentMachines": n },
 *       "trashId"?: the trash entry that holds what a forced delete of stored reports removed }
 *     (a dry run adds "dryRun": true)
 *
 * 200 ok · 400 invalid provider id · 401 no session · 403 foreign origin, demo mode, or no sudo grant
 * (not for a dry run) · 404 no such provider · 409 provider_has_events (without force) · 503 Redis down
 */

type Params = { provider: string };

export async function DELETE(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { provider } = await context.params;
  return withApiHandler("api/providers/[provider]", async ({ request, url }) => {
    const origin = requireSameOrigin(request);
    if (origin) return origin;
    const readOnly = demoReadOnly();
    if (readOnly) return readOnly;
    const tenant = await requireTenantSession();
    if (tenant instanceof Response) return tenant;
    const { store } = tenant;
    const now = new Date();

    const providerId = normalizeProviderId(provider);
    if (!providerId) return apiError("invalid_payload", 400, { details: ["invalid provider id"] });

    // A dry run only counts: it needs the session, not a sudo grant.
    const dryRun = url.searchParams.get("dryRun") === "1";
    if (!dryRun && !(await hasSudo())) return apiError("sudo_required", 403);

    const force = url.searchParams.get("force") === "1";
    const result = await deleteProvider(store, providerId, force, now, {
      dryRun,
      ...(!dryRun && { audit: manageAudit(tenant, now) }),
    });
    if (!result.ok) {
      return apiError(
        result.reason === "has_events" ? "provider_has_events" : "not_found",
        result.reason === "has_events" ? 409 : 404,
      );
    }
    return json(
      {
        ok: true,
        ...(dryRun && { dryRun: true }),
        affected: result.affected,
        impact: result.impact,
        ...(result.trashId && { trashId: result.trashId }),
      },
      200,
    );
  })(request);
}
