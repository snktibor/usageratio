import { apiError, json, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { demoReadOnly } from "@/lib/demo/mode";
import { deleteProvider } from "@/lib/manage-store";
import { normalizeProviderId } from "@/lib/providers";

/**
 * DELETE /api/providers/[provider] — removes a provider outright: its events
 * in every group, its machines, its official-usage figures, and every trace
 * of it in the settings document (limits, sub-limits, hiddenProviders,
 * excludedProviders). The settings panel only offers this for a provider
 * already hidden. Needs a fresh sudo grant; `?force=1` is required when it
 * still has stored events, so a click cannot lose history by accident.
 *
 *   DELETE          → 409 provider_has_events unless it has none
 *   DELETE?force=1  → deletes its reports too
 *
 *   → { "ok": true, "affected": { events, machines, groups } }
 *
 * 200 ok · 400 invalid provider id · 401 no session · 403 foreign origin, demo mode, or no sudo grant ·
 * 404 no such provider · 409 provider_has_events (without force) · 503 Redis down
 */

type Params = { provider: string };

export async function DELETE(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { provider } = await context.params;
  return withApiHandler("api/providers/[provider]", async ({ request, url }) => {
    const origin = requireSameOrigin(request);
    if (origin) return origin;
    const readOnly = demoReadOnly();
    if (readOnly) return readOnly;
    const unauthorized = await requireSession();
    if (unauthorized) return unauthorized;
    if (!(await hasSudo())) return apiError("sudo_required", 403);

    const providerId = normalizeProviderId(provider);
    if (!providerId) return apiError("invalid_payload", 400, { details: ["invalid provider id"] });

    const force = url.searchParams.get("force") === "1";
    const result = await deleteProvider(providerId, force, new Date());
    if (!result.ok) {
      return apiError(
        result.reason === "has_events" ? "provider_has_events" : "not_found",
        result.reason === "has_events" ? 409 : 404,
      );
    }
    return json({ ok: true, affected: result.affected }, 200);
  })(request);
}
