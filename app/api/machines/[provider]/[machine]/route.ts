import { apiError, json, readJsonBody, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { demoReadOnly } from "@/lib/demo/mode";
import { deleteMachine, moveMachine } from "@/lib/manage-store";
import { normalizeProviderId } from "@/lib/providers";
import { resetFor, resolveConfig } from "@/lib/settings";
import { loadRawSettings } from "@/lib/usage-store";
import { parseId } from "@/lib/validation";

/**
 * /api/machines/[provider]/[machine] — move (rename, regroup, merge) or delete
 * one machine's index entry and its stored reports. Behind the dashboard's
 * session; a merge and a DELETE also need a fresh sudo grant (POST
 * /api/auth/sudo within the last 5 minutes), since both drop reports for
 * good. A move onto an id this provider already uses is refused unless
 * `merge` is set; the merge then combines the two histories day by day (see
 * lib/manage-store.ts `moveMachine`).
 *
 *   PATCH { "id"?: "new-machine-id", "group"?: "group-id", "merge"?: true }
 *         → { "ok": true, "affected": { events, machines, groups } }
 *   DELETE → { "ok": true, "affected": { events, machines, groups } }
 *
 * 200 ok · 400 invalid id/body · 401 no session · 403 foreign origin, demo mode, or (merge, DELETE) no sudo grant ·
 * 404 not_found (no such machine) or group_not_found · 409 machine_exists, or merge_unsupported outside snapshot mode (PATCH only) ·
 * 413/415 bad body (PATCH) · 503 Redis down
 */

const MAX_BODY_BYTES = 1024;

type Params = { provider: string; machine: string };

function parseSegments(raw: Params): { providerId: string; machineId: string } | null {
  const providerId = normalizeProviderId(raw.provider);
  const errors: string[] = [];
  const machineId = parseId(raw.machine, "machine", errors);
  return providerId && errors.length === 0 ? { providerId, machineId } : null;
}

function parseMoveBody(value: unknown): { id?: string; group?: string; merge: boolean } | { errors: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { errors: ["body must be a JSON object"] };
  }
  const body = value as Record<string, unknown>;
  const errors: string[] = [];
  const id = body.id === undefined ? undefined : parseId(body.id, "id", errors);
  const group = body.group === undefined ? undefined : parseId(body.group, "group", errors);
  if (id === undefined && group === undefined) errors.push("id or group is required");
  if (body.merge !== undefined && typeof body.merge !== "boolean") errors.push("merge must be true or false");
  return errors.length > 0
    ? { errors }
    : { ...(id !== undefined && { id }), ...(group !== undefined && { group }), merge: body.merge === true };
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
    const parsed = parseMoveBody(body.value);
    if ("errors" in parsed) return apiError("invalid_payload", 400, { details: parsed.errors });
    if (parsed.merge && !(await hasSudo())) return apiError("sudo_required", 403);

    const config = resolveConfig(getConfig(), await loadRawSettings());
    const result = await moveMachine(
      segments.providerId,
      segments.machineId,
      { machineId: parsed.id, groupId: parsed.group },
      {
        merge: parsed.merge,
        mode: config.tokenMode,
        reset: resetFor(config, segments.providerId),
        retentionDays: config.retentionDays,
        now: new Date(),
      },
    );
    if (!result.ok) {
      if (result.reason === "exists") return apiError("machine_exists", 409);
      if (result.reason === "unsupported_mode") return apiError("merge_unsupported", 409);
      return apiError(result.reason === "group_not_found" ? "group_not_found" : "not_found", 404);
    }
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
