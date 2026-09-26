import { apiError, json, readJsonBody, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { demoReadOnly } from "@/lib/demo/mode";
import { deleteGroup, renameOrMergeGroup } from "@/lib/manage-store";
import { parseId } from "@/lib/validation";

/**
 * /api/groups/[group] — rename, merge or delete a group. Behind the
 * dashboard's session; a merge (`{"merge": true}`, onto a group that already
 * exists) and a delete both need a fresh sudo grant, since either can lose
 * data (a merge combines two histories, a delete drops them). A plain rename
 * onto an unused id needs neither.
 *
 *   PATCH { "id": "new-name" }              → 409 group_exists unless the id is free
 *   PATCH { "id": "existing", "merge": true } → unions the two groups' history (needs sudo)
 *   DELETE                                    → 409 group_has_events unless ?force=1
 *   DELETE?force=1                            → deletes its reports too (needs sudo)
 *
 *   → { "ok": true, "affected": { events, machines, groups } }
 *
 * 200 ok · 400 invalid id/body · 401 no session · 403 foreign origin, demo mode, or no sudo grant ·
 * 404 no such group · 409 group_exists (PATCH) / group_has_events (DELETE without force) ·
 * 413/415 bad body (PATCH) · 503 Redis down
 */

type Params = { group: string };

function parseGroupBody(value: unknown): { id: string; merge: boolean } | { errors: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { errors: ["body must be a JSON object"] };
  }
  const body = value as Record<string, unknown>;
  const errors: string[] = [];
  const id = parseId(body.id, "id", errors);
  if (body.merge !== undefined && typeof body.merge !== "boolean") errors.push("merge must be true or false");
  return errors.length > 0 ? { errors } : { id, merge: body.merge === true };
}

export async function PATCH(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { group } = await context.params;
  return withApiHandler("api/groups/[group]", async ({ request }) => {
    const origin = requireSameOrigin(request);
    if (origin) return origin;
    const readOnly = demoReadOnly();
    if (readOnly) return readOnly;
    const unauthorized = await requireSession();
    if (unauthorized) return unauthorized;

    const idErrors: string[] = [];
    const groupId = parseId(group, "group", idErrors);
    if (idErrors.length > 0) return apiError("invalid_payload", 400, { details: idErrors });

    const body = await readJsonBody(request, { maxBytes: 1024 });
    if (!body.ok) return body.response;
    const parsed = parseGroupBody(body.value);
    if ("errors" in parsed) return apiError("invalid_payload", 400, { details: parsed.errors });

    if (parsed.merge && !(await hasSudo())) return apiError("sudo_required", 403);

    const result = await renameOrMergeGroup(groupId, parsed.id, parsed.merge, new Date());
    if (!result.ok)
      return apiError(
        result.reason === "exists" ? "group_exists" : "not_found",
        result.reason === "exists" ? 409 : 404,
      );
    return json({ ok: true, affected: result.affected }, 200);
  })(request);
}

export async function DELETE(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { group } = await context.params;
  return withApiHandler("api/groups/[group]", async ({ request, url }) => {
    const origin = requireSameOrigin(request);
    if (origin) return origin;
    const readOnly = demoReadOnly();
    if (readOnly) return readOnly;
    const unauthorized = await requireSession();
    if (unauthorized) return unauthorized;
    if (!(await hasSudo())) return apiError("sudo_required", 403);

    const idErrors: string[] = [];
    const groupId = parseId(group, "group", idErrors);
    if (idErrors.length > 0) return apiError("invalid_payload", 400, { details: idErrors });

    const force = url.searchParams.get("force") === "1";
    const result = await deleteGroup(groupId, force, new Date());
    if (!result.ok) {
      return apiError(
        result.reason === "has_events" ? "group_has_events" : "not_found",
        result.reason === "has_events" ? 409 : 404,
      );
    }
    return json({ ok: true, affected: result.affected }, 200);
  })(request);
}
