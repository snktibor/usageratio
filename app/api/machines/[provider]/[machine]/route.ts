import { apiError, json, readJsonBody, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { demoReadOnly } from "@/lib/demo/mode";
import { deleteMachine, renameMachine } from "@/lib/manage-store";
import { normalizeProviderId } from "@/lib/providers";
import { parseId } from "@/lib/validation";

/**
 * /api/machines/[provider]/[machine] — rename or delete one machine's index
 * entry and its stored reports. Behind the dashboard's session; DELETE also
 * needs a fresh sudo grant (POST /api/auth/sudo within the last 5 minutes),
 * since it drops reports for good. No merge: renaming onto an id already used
 * by this provider is refused rather than combined — two snapshot series
 * merged would be read as a max, not a sum, silently losing tokens (see
 * lib/manage-store.ts).
 *
 *   PATCH { "id": "new-machine-id" } → { "ok": true, "affected": { events, machines, groups } }
 *   DELETE                            → { "ok": true, "affected": { events, machines, groups } }
 *
 * 200 ok · 400 invalid id/body · 401 no session · 403 foreign origin, demo mode, or (DELETE) no sudo grant ·
 * 404 no such machine · 409 machine_exists (PATCH only) · 413/415 bad body (PATCH) · 503 Redis down
 */

const MAX_BODY_BYTES = 1024;

type Params = { provider: string; machine: string };

function parseSegments(raw: Params): { providerId: string; machineId: string } | null {
  const providerId = normalizeProviderId(raw.provider);
  const errors: string[] = [];
  const machineId = parseId(raw.machine, "machine", errors);
  return providerId && errors.length === 0 ? { providerId, machineId } : null;
}

function parseRenameBody(value: unknown): { id: string } | { errors: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { errors: ["body must be a JSON object"] };
  }
  const errors: string[] = [];
  const id = parseId((value as Record<string, unknown>).id, "id", errors);
  return errors.length > 0 ? { errors } : { id };
}

export async function PATCH(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const raw = await context.params;
  return withApiHandler("api/machines/[provider]/[machine]", async ({ request }) => {
    const origin = requireSameOrigin(request);
    if (origin) return origin;
    const readOnly = demoReadOnly();
    if (readOnly) return readOnly;
    const unauthorized = await requireSession();
    if (unauthorized) return unauthorized;

    const segments = parseSegments(raw);
    if (!segments) return apiError("invalid_payload", 400, { details: ["invalid provider or machine id"] });

    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.response;
    const parsed = parseRenameBody(body.value);
    if ("errors" in parsed) return apiError("invalid_payload", 400, { details: parsed.errors });

    const result = await renameMachine(segments.providerId, segments.machineId, parsed.id);
    if (!result.ok)
      return apiError(
        result.reason === "exists" ? "machine_exists" : "not_found",
        result.reason === "exists" ? 409 : 404,
      );
    return json({ ok: true, affected: result.affected }, 200);
  })(request);
}

export async function DELETE(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const raw = await context.params;
  return withApiHandler("api/machines/[provider]/[machine]", async ({ request }) => {
    const origin = requireSameOrigin(request);
    if (origin) return origin;
    const readOnly = demoReadOnly();
    if (readOnly) return readOnly;
    const unauthorized = await requireSession();
    if (unauthorized) return unauthorized;
    if (!(await hasSudo())) return apiError("sudo_required", 403);

    const segments = parseSegments(raw);
    if (!segments) return apiError("invalid_payload", 400, { details: ["invalid provider or machine id"] });

    const result = await deleteMachine(segments.providerId, segments.machineId);
    if (!result.ok) return apiError("not_found", 404);
    return json({ ok: true, affected: result.affected }, 200);
  })(request);
}
